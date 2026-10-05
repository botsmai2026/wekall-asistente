terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Sin backend remoto: este código no se ha desplegado. Antes de un apply real,
  # el estado debe ir a un backend compartido y cifrado (S3 con bloqueo), no a un
  # archivo local.
}
