# Terraform: la base de AWS

Una parte del diseño de [`docs/AWS.md`](../../docs/AWS.md) escrita como código. No está desplegada: se validó con `terraform validate`, sin credenciales de AWS y sin crear nada.

## Qué incluye

| Parte | Recursos | Sección de `docs/AWS.md` |
|---|---|---|
| Red | VPC en dos zonas; subredes públicas, de aplicación y de datos; puerta de enlace a internet; un NAT por zona; tablas de rutas (las de datos sin ruta a internet); punto de enlace de S3 | 3.6 |
| Grupos de seguridad | Balanceador (443 desde internet), API (solo desde el balanceador), resto de tareas (sin entrada) y RDS (5432 solo desde los dos grupos de tareas) | 3.6 |
| PostgreSQL | RDS PostgreSQL 16, instancia Multi-AZ, `db.m7g.large`, 50 GB gp3 cifrados, en las subredes de datos. La contraseña la genera y la rota RDS en Secrets Manager | 3.2 y 3.9 |
| Cola de envío | SQS FIFO para las respuestas a WhatsApp, su cola de fallidos (FIFO), la política de reenvío y una alarma de CloudWatch cuando hay mensajes en la de fallidos. La alarma avisa a un tema de SNS sin suscriptores | 3.8 |
| Secretos | Contenedores vacíos para la clave de OpenAI, la cadena de conexión de Atlas, el secreto de la aplicación de Meta y el token de WhatsApp | 3.9 |
| Logs | Un grupo de CloudWatch por servicio de ECS | 3.10 |

## Qué no incluye

Los servicios de ECS (API, workers, relevo de trazas, envío), el balanceador y sus listeners, WAF, Cognito, MongoDB Atlas y su emparejamiento de VPC, DNS, certificados, roles de IAM por servicio, ECR y la integración continua. Siguen siendo diseño. Tampoco hay backend remoto para el estado.

## Cómo validarlo

Con Terraform 1.6 o posterior instalado, desde la raíz del repositorio:

```bash
terraform -chdir=infra/terraform fmt -check
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
```

Sin Terraform instalado, con Docker y la imagen oficial. En PowerShell, cambie `$(pwd)` por `${PWD}`. En Git Bash, anteponga `MSYS_NO_PATHCONV=1` a cada comando: sin eso, Git Bash convierte `/repo` en una ruta de Windows y Docker la rechaza.

```bash
docker run --rm -v "$(pwd):/repo" -w /repo hashicorp/terraform:1.16.5 -chdir=infra/terraform fmt -check
docker run --rm -v "$(pwd):/repo" -w /repo hashicorp/terraform:1.16.5 -chdir=infra/terraform init -backend=false
docker run --rm -v "$(pwd):/repo" -w /repo hashicorp/terraform:1.16.5 -chdir=infra/terraform validate
```

Ninguno de los tres comandos usa credenciales de AWS ni crea recursos. `init` descarga el proveedor `hashicorp/aws` del registro de Terraform. `terraform plan` sí necesita credenciales de una cuenta de AWS: sin ellas falla con "No valid credential sources found".

El archivo `.terraform.lock.hcl` fija la versión del proveedor y trae sus huellas para `linux_amd64`, `windows_amd64` y `darwin_arm64`. En otra plataforma, `init` agrega la suya y modifica el archivo.

## Antes de un despliegue real

- Configurar un backend remoto para el estado (S3 con bloqueo).
- Cargar el valor de cada secreto fuera de Terraform, para que no quede en el código ni en el estado:

  ```bash
  aws secretsmanager put-secret-value --secret-id wekall-asistente/produccion/openai-api-key --secret-string '...'
  ```

- Suscribir al tema de SNS de las alarmas (salida `tema_alarmas`) a quien deba recibir el aviso. Sin suscriptores, la alarma no le llega a nadie.
- RDS se crea con protección contra borrado y deja una copia final al eliminarse.
- Las migraciones del proyecto activan `vector` y `btree_gist` con `CREATE EXTENSION`; RDS PostgreSQL 16 trae las dos.
- Dos cambios de la aplicación que este código no resuelve (detalle en `docs/AWS.md`, sección 9):
  - conectar a RDS con TLS, verificando el certificado con la autoridad de Amazon RDS;
  - decidir cómo leen las tareas la contraseña que RDS rota cada 7 días. Entregarla solo al arrancar la tarea no soporta la rotación.

## Valores que fija este código y no `docs/AWS.md`

Están en `variables.tf` y se pueden cambiar:

| Variable | Valor | Motivo |
|---|---|---|
| `rds_retencion_copias_dias` | 7 | Copias automáticas y recuperación a un punto en el tiempo |
| `logs_retencion_dias` | 30 | Los logs no llevan texto de pacientes (docs/AWS.md, 3.10) |
| `envio_max_recepciones` | 5 | Entregas fallidas antes de pasar a la cola de fallidos |
| `envio_visibilidad_segundos` | 60 | Debe superar lo que tarda el consumidor en comprobar en PostgreSQL, llamar a Meta y registrar el envío |

Con 5 entregas y 60 s de visibilidad, y con reintentos continuos, una caída de Meta de más de aproximadamente 5 minutos pasa las respuestas pendientes a la cola de fallidos, que las conserva 14 días. Se devuelven a la cola de envío con un redrive cuando Meta se recupera (`docs/AWS.md`, sección 3.8).
