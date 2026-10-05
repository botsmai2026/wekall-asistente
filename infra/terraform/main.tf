# La base de la infraestructura de docs/AWS.md: red, grupos de seguridad,
# PostgreSQL, la cola de envío a WhatsApp, los secretos y los logs.
#
# No incluye los servicios de ECS, el balanceador, WAF, Cognito, MongoDB Atlas,
# DNS ni certificados: siguen siendo diseño (docs/AWS.md, sección 10).

locals {
  prefijo = "${var.nombre}-${var.entorno}"

  # Zona -> posición (0 o 1). La posición fija el rango de cada subred, así que
  # cambiar el orden de las zonas mueve las subredes.
  zonas = { for i, zona in var.zonas : zona => i }
}

# ---------------------------------------------------------------------------
# Red (docs/AWS.md, sección 3.6)
#
# Tres niveles de subred por zona:
#   públicas: balanceador y NAT
#   aplicación: tareas de ECS, salen a internet por el NAT de su zona
#   datos: RDS, sin ninguna ruta a internet
# ---------------------------------------------------------------------------

resource "aws_vpc" "principal" {
  cidr_block = var.vpc_cidr
  # RDS y el punto de enlace de S3 se resuelven por DNS dentro de la VPC.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.prefijo }
}

resource "aws_internet_gateway" "principal" {
  vpc_id = aws_vpc.principal.id
  tags   = { Name = local.prefijo }
}

resource "aws_subnet" "publica" {
  for_each = local.zonas

  vpc_id            = aws_vpc.principal.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, each.value)

  tags = { Name = "${local.prefijo}-publica-${each.key}", Nivel = "publica" }
}

resource "aws_subnet" "aplicacion" {
  for_each = local.zonas

  vpc_id            = aws_vpc.principal.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 10 + each.value)

  tags = { Name = "${local.prefijo}-aplicacion-${each.key}", Nivel = "aplicacion" }
}

resource "aws_subnet" "datos" {
  for_each = local.zonas

  vpc_id            = aws_vpc.principal.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 20 + each.value)

  tags = { Name = "${local.prefijo}-datos-${each.key}", Nivel = "datos" }
}

resource "aws_route_table" "publica" {
  vpc_id = aws_vpc.principal.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.principal.id
  }

  tags = { Name = "${local.prefijo}-publica" }
}

resource "aws_route_table_association" "publica" {
  for_each = aws_subnet.publica

  subnet_id      = each.value.id
  route_table_id = aws_route_table.publica.id
}

# Un NAT por zona: si cae una zona, las tareas de la otra siguen llegando a
# OpenAI y a Meta (docs/AWS.md, sección 3.6).
resource "aws_eip" "nat" {
  for_each = local.zonas

  domain = "vpc"
  tags   = { Name = "${local.prefijo}-nat-${each.key}" }
}

resource "aws_nat_gateway" "zona" {
  for_each = local.zonas

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.publica[each.key].id

  tags = { Name = "${local.prefijo}-${each.key}" }

  depends_on = [aws_internet_gateway.principal]
}

# Cada subred de aplicación sale por el NAT de su propia zona.
resource "aws_route_table" "aplicacion" {
  for_each = local.zonas

  vpc_id = aws_vpc.principal.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.zona[each.key].id
  }

  tags = { Name = "${local.prefijo}-aplicacion-${each.key}" }
}

resource "aws_route_table_association" "aplicacion" {
  for_each = aws_subnet.aplicacion

  subnet_id      = each.value.id
  route_table_id = aws_route_table.aplicacion[each.key].id
}

# Tabla propia para las subredes de datos, sin rutas: solo el tráfico local de
# la VPC. Explícita para no depender de lo que tenga la tabla principal.
resource "aws_route_table" "datos" {
  vpc_id = aws_vpc.principal.id
  tags   = { Name = "${local.prefijo}-datos" }
}

resource "aws_route_table_association" "datos" {
  for_each = aws_subnet.datos

  subnet_id      = each.value.id
  route_table_id = aws_route_table.datos.id
}

# Punto de enlace de S3: es gratuito y evita pasar por el NAT las capas de las
# imágenes de ECR, que se descargan de S3. Los de ECR, CloudWatch y Secrets
# Manager no se crean: cuestan más que el tráfico que ahorrarían (docs/AWS.md, sección 3.6).
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.principal.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for tabla in aws_route_table.aplicacion : tabla.id]

  tags = { Name = "${local.prefijo}-s3" }
}

# ---------------------------------------------------------------------------
# Grupos de seguridad: solo el camino necesario (docs/AWS.md, sección 3.6)
#
#   internet -> balanceador :443
#   balanceador -> API :puerto_api
#   API y demás tareas -> RDS :5432
#   tareas -> internet :443 (OpenAI, Meta y las API de AWS, por el NAT)
#
# RDS no acepta nada de internet ni de la red en general: solo de los dos grupos
# de tareas. Las reglas van como recursos separados para que ningún grupo tenga
# una regla de salida implícita.
# ---------------------------------------------------------------------------

resource "aws_security_group" "balanceador" {
  name        = "${local.prefijo}-balanceador"
  description = "Balanceador: recibe el webhook de Meta y la interfaz del coordinador"
  vpc_id      = aws_vpc.principal.id
  tags        = { Name = "${local.prefijo}-balanceador" }
}

resource "aws_security_group" "api" {
  name        = "${local.prefijo}-api"
  description = "Tareas de la API: solo reciben del balanceador"
  vpc_id      = aws_vpc.principal.id
  tags        = { Name = "${local.prefijo}-api" }
}

# Workers, relevo de trazas y envío a WhatsApp: no reciben conexiones de nadie.
resource "aws_security_group" "tareas" {
  name        = "${local.prefijo}-tareas"
  description = "Workers, relevo de trazas y envio: sin trafico de entrada"
  vpc_id      = aws_vpc.principal.id
  tags        = { Name = "${local.prefijo}-tareas" }
}

resource "aws_security_group" "rds" {
  name        = "${local.prefijo}-rds"
  description = "PostgreSQL: solo desde las tareas de la aplicacion"
  vpc_id      = aws_vpc.principal.id
  tags        = { Name = "${local.prefijo}-rds" }
}

resource "aws_vpc_security_group_ingress_rule" "balanceador_https" {
  security_group_id = aws_security_group.balanceador.id
  description       = "HTTPS publico: webhook de Meta e interfaz"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "balanceador_a_api" {
  security_group_id            = aws_security_group.balanceador.id
  description                  = "Hacia las tareas de la API"
  ip_protocol                  = "tcp"
  from_port                    = var.puerto_api
  to_port                      = var.puerto_api
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "api_desde_balanceador" {
  security_group_id            = aws_security_group.api.id
  description                  = "Solo desde el balanceador"
  ip_protocol                  = "tcp"
  from_port                    = var.puerto_api
  to_port                      = var.puerto_api
  referenced_security_group_id = aws_security_group.balanceador.id
}

resource "aws_vpc_security_group_egress_rule" "a_rds" {
  for_each = {
    api    = aws_security_group.api.id
    tareas = aws_security_group.tareas.id
  }

  security_group_id            = each.value
  description                  = "Hacia PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.rds.id
}

resource "aws_vpc_security_group_egress_rule" "a_internet_https" {
  for_each = {
    api    = aws_security_group.api.id
    tareas = aws_security_group.tareas.id
  }

  security_group_id = each.value
  description       = "HTTPS saliente por el NAT: OpenAI, Meta, Secrets Manager, ECR, CloudWatch"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "rds_desde_tareas" {
  for_each = {
    api    = aws_security_group.api.id
    tareas = aws_security_group.tareas.id
  }

  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL desde ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
}

# ---------------------------------------------------------------------------
# PostgreSQL (docs/AWS.md, sección 3.2): RDS, instancia Multi-AZ
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "datos" {
  name        = "${local.prefijo}-datos"
  description = "Subredes de datos, sin ruta a internet"
  subnet_ids  = [for subred in aws_subnet.datos : subred.id]
}

resource "aws_db_instance" "postgres" {
  identifier     = "${local.prefijo}-postgres"
  engine         = "postgres"
  engine_version = var.rds_version_motor
  instance_class = var.rds_clase
  multi_az       = true

  allocated_storage = var.rds_almacenamiento_gb
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "asistente"
  username = var.rds_usuario_maestro
  # La contraseña la genera RDS, la guarda en Secrets Manager y la rota. No
  # aparece en este código ni en el estado de Terraform.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.datos.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  port                   = 5432

  backup_retention_period = var.rds_retencion_copias_dias
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false

  # La base es la fuente de verdad: borrarla exige quitar antes esta protección,
  # y al borrarla queda una copia final.
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.prefijo}-postgres-final"

  # pgvector y btree_gist vienen con RDS PostgreSQL 16; las migraciones del
  # proyecto los activan con CREATE EXTENSION. Desde la versión 15, RDS exige
  # TLS por defecto (rds.force_ssl = 1), así que no hace falta un grupo de parámetros.
}

# ---------------------------------------------------------------------------
# Cola de envío a WhatsApp (docs/AWS.md, sección 3.8)
#
# FIFO: la conversación es el grupo (conserva el orden por paciente) y el
# message_id es el identificador de deduplicación, que pone quien publica; por
# eso no se deduplica por contenido. PostgreSQL reduce los reenvíos ya
# registrados; SQS solo recuerda la deduplicación durante 5 minutos. Sigue
# existiendo una ventana de duplicado si Meta acepta el envío y el registro
# local no se completa.
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "envio_fallidos" {
  # La cola de fallidos de una cola FIFO también tiene que ser FIFO.
  name                      = "${local.prefijo}-envio-whatsapp-fallidos.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600 # 14 días, el máximo: tiempo para revisarlos
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "envio" {
  name                        = "${local.prefijo}-envio-whatsapp.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  visibility_timeout_seconds  = var.envio_visibilidad_segundos
  sqs_managed_sse_enabled     = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.envio_fallidos.arn
    maxReceiveCount     = var.envio_max_recepciones
  })
}

# Solo la cola de envío puede mandar mensajes a esta cola de fallidos.
resource "aws_sqs_queue_redrive_allow_policy" "envio_fallidos" {
  queue_url = aws_sqs_queue.envio_fallidos.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.envio.arn]
  })
}

# Destino de las alarmas. Se crea sin suscriptores: quién recibe el aviso (correo,
# chat, guardia) se decide al desplegar, con el ARN de la salida tema_alarmas.
# Sin cifrado en reposo: el aviso solo lleva el nombre y el estado de la alarma,
# no datos de pacientes.
resource "aws_sns_topic" "alarmas" {
  name = "${local.prefijo}-alarmas"
}

# Un mensaje en la cola de fallidos es una respuesta que el paciente no recibió.
resource "aws_cloudwatch_metric_alarm" "envio_fallidos" {
  alarm_name        = "${local.prefijo}-envio-whatsapp-fallidos"
  alarm_description = "Hay respuestas que no se pudieron enviar a WhatsApp tras ${var.envio_max_recepciones} intentos"

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions  = { QueueName = aws_sqs_queue.envio_fallidos.name }
  statistic   = "Maximum"
  period      = 300

  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  # Una cola sin mensajes puede no publicar datos: eso no es una alarma.
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.alarmas.arn]
  ok_actions    = [aws_sns_topic.alarmas.arn]
}

# ---------------------------------------------------------------------------
# Secretos (docs/AWS.md, sección 3.9)
#
# Solo los contenedores, sin valor: el valor se carga fuera de Terraform (ver
# README de esta carpeta), para que nunca quede en el código ni en el estado.
# La credencial de la base no está aquí: la crea RDS (manage_master_user_password).
# Secretos separados para que cada servicio reciba permiso solo sobre los suyos.
# ---------------------------------------------------------------------------

locals {
  secretos = {
    "openai-api-key"    = "Clave de la API de OpenAI. La usa el worker."
    "mongodb-atlas-uri" = "Cadena de conexion de MongoDB Atlas. La usan el relevo de trazas y la API, que lee las trazas para el detalle."
    "meta-app-secret"   = "Secreto de la aplicacion de Meta, para verificar la firma X-Hub-Signature-256 del webhook. Lo usa la API."
    "meta-access-token" = "Token de acceso de la API de WhatsApp Cloud. Lo usa el servicio de envio."
  }
}

resource "aws_secretsmanager_secret" "aplicacion" {
  for_each = local.secretos

  name        = "${var.nombre}/${var.entorno}/${each.key}"
  description = each.value
}

# ---------------------------------------------------------------------------
# Logs (docs/AWS.md, sección 3.10): un grupo por servicio de ECS. Los servicios
# no están en este código; los grupos quedan listos para ellos.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "servicio" {
  for_each = toset(["api", "worker", "relevo-trazas", "envio-whatsapp"])

  name              = "/ecs/${local.prefijo}/${each.key}"
  retention_in_days = var.logs_retencion_dias
}
