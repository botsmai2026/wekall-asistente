# Los valores por defecto son los de docs/AWS.md. Los que el documento no fija
# (retenciones, reintentos de la cola) están marcados como decisión de este código.

variable "region" {
  description = "Región de AWS (docs/AWS.md, sección 3.1)."
  type        = string
  default     = "us-east-1"
}

variable "nombre" {
  description = "Prefijo de los nombres de los recursos."
  type        = string
  default     = "wekall-asistente"
}

variable "entorno" {
  description = "Nombre del entorno, parte del prefijo."
  type        = string
  default     = "produccion"
}

variable "vpc_cidr" {
  description = "Rango de la VPC. Las subredes se derivan de él."
  type        = string
  default     = "10.0.0.0/16"
}

variable "zonas" {
  description = "Las dos zonas de disponibilidad (docs/AWS.md, sección 3.6)."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]

  validation {
    condition     = length(var.zonas) == 2
    error_message = "El diseño usa exactamente dos zonas de disponibilidad."
  }
}

variable "puerto_api" {
  description = "Puerto en el que escucha la API dentro de su tarea (el mismo de docker-compose.yml)."
  type        = number
  default     = 3000
}

variable "rds_clase" {
  description = "Clase de la instancia de RDS (docs/AWS.md, sección 3.2)."
  type        = string
  default     = "db.m7g.large"
}

variable "rds_almacenamiento_gb" {
  description = "Almacenamiento gp3 de RDS, en GB (docs/AWS.md, sección 3.2)."
  type        = number
  default     = 50
}

variable "rds_version_motor" {
  description = "Versión mayor de PostgreSQL. RDS elige la menor más reciente y la actualiza en la ventana de mantenimiento."
  type        = string
  default     = "16"
}

variable "rds_usuario_maestro" {
  description = "Usuario maestro de RDS. Su contraseña la genera y la rota RDS en Secrets Manager; no pasa por Terraform."
  type        = string
  default     = "asistente_admin"
}

variable "rds_retencion_copias_dias" {
  description = "Días de copias automáticas y de recuperación a un punto en el tiempo. Decisión de este código: docs/AWS.md no fija el plazo."
  type        = number
  default     = 7
}

variable "logs_retencion_dias" {
  description = "Días que se conservan los logs de las tareas. Decisión de este código: docs/AWS.md no fija el plazo."
  type        = number
  default     = 30
}

variable "envio_max_recepciones" {
  description = "Veces que un mensaje de la cola de envío se entrega sin éxito antes de pasar a la cola de fallidos. Decisión de este código."
  type        = number
  default     = 5
}

variable "envio_visibilidad_segundos" {
  description = "Tiempo que un mensaje en proceso queda oculto para otros consumidores. Debe superar lo que tarda el consumidor en comprobar en PostgreSQL, llamar a Meta y registrar el envío. Decisión de este código."
  type        = number
  default     = 60
}
