provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Proyecto      = var.nombre
      Entorno       = var.entorno
      GestionadoPor = "terraform"
    }
  }
}
