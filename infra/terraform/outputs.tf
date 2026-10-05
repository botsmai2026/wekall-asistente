output "vpc_id" {
  value = aws_vpc.principal.id
}

output "subredes" {
  description = "Identificadores de las subredes, por nivel y zona."
  value = {
    publicas   = { for zona, subred in aws_subnet.publica : zona => subred.id }
    aplicacion = { for zona, subred in aws_subnet.aplicacion : zona => subred.id }
    datos      = { for zona, subred in aws_subnet.datos : zona => subred.id }
  }
}

output "grupos_de_seguridad" {
  value = {
    balanceador = aws_security_group.balanceador.id
    api         = aws_security_group.api.id
    tareas      = aws_security_group.tareas.id
    rds         = aws_security_group.rds.id
  }
}

output "postgres_endpoint" {
  description = "Dirección y puerto de RDS, para POSTGRES_URL."
  value       = aws_db_instance.postgres.endpoint
}

output "postgres_secreto_credencial" {
  description = "ARN del secreto que RDS creó y rota con la contraseña del usuario maestro."
  value       = aws_db_instance.postgres.master_user_secret[0].secret_arn
}

output "cola_envio" {
  value = {
    url          = aws_sqs_queue.envio.url
    arn          = aws_sqs_queue.envio.arn
    url_fallidos = aws_sqs_queue.envio_fallidos.url
    arn_fallidos = aws_sqs_queue.envio_fallidos.arn
  }
}

output "tema_alarmas" {
  description = "ARN del tema de SNS que recibe las alarmas. No tiene suscriptores: hay que conectar uno al desplegar."
  value       = aws_sns_topic.alarmas.arn
}

output "secretos" {
  description = "ARN de los secretos de la aplicación. Se crean vacíos."
  value       = { for clave, secreto in aws_secretsmanager_secret.aplicacion : clave => secreto.arn }
}

output "grupos_de_logs" {
  value = { for servicio, grupo in aws_cloudwatch_log_group.servicio : servicio => grupo.name }
}
