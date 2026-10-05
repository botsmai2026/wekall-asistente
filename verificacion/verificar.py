"""Verificación del esquema y las consultas contra un PostgreSQL real.

Uso:
    pip install psycopg2-binary
    python3 verificar.py [--dsn "host=localhost port=5432 user=postgres password=..."]
                         [--esquema 001_esquema.sql] [--consultas consultas.sql] [--ingestion ingestion.sql]

Crea una base temporal llamada "verificacion", aplica el esquema indicado y las
migraciones que lo acompañan (002_..., en orden), y prueba restricciones,
concurrencia y planes de ejecución.

Qué archivos verifica: los que se le indiquen (por defecto, los de la carpeta
sql/). Al empezar imprime la ruta y la huella SHA-256 de cada uno, y
las deja en resultado.txt, para que no haya duda de qué versión se probó.

Las sentencias de la aplicación NO están copiadas aquí: se cargan de
consultas.sql e ingestion.sql por su nombre ("-- name: ..."). Este script solo contiene el
orden en que cada transacción las ejecuta y los datos de prueba.

pgvector: con la extensión instalada se ejecutan todas las sentencias, incluida
la búsqueda vectorial (así se obtuvo el resultado.txt que acompaña a este
script). Sin ella el script también corre, pero sustituye la columna del vector
por texto, omite la sección 7b y lo declara en resultado.txt: en ese caso la
búsqueda vectorial queda SIN verificar y el total de comprobaciones es menor.
"""
import argparse, hashlib, os, re, sys, threading, time, json
from datetime import datetime, timezone
import psycopg2
from psycopg2 import errors

AQUI = os.path.dirname(os.path.abspath(__file__))
_a = argparse.ArgumentParser()
_a.add_argument("--dsn", default="host=/tmp port=5544 user=postgres")
_a.add_argument("--esquema", default=os.path.join(AQUI, "..", "sql", "001_esquema.sql"))
_a.add_argument("--consultas", default=os.path.join(AQUI, "..", "sql", "consultas.sql"))
_a.add_argument("--ingestion", default=os.path.join(AQUI, "..", "sql", "ingestion.sql"))
ARGS = _a.parse_args()
DSN = ARGS.dsn
resultados = []
_salida = []


def decir(texto=""):
    print(texto); _salida.append(texto)


def huella(ruta):
    return hashlib.sha256(open(ruta, "rb").read()).hexdigest()


def cargar_consultas(ruta):
    """Lee los bloques '-- name: x' de consultas.sql. Devuelve {nombre: sql} listo para psycopg2."""
    consultas, nombre, lineas = {}, None, []

    def guardar():
        if nombre:
            sql = "\n".join(l for l in lineas if not l.lstrip().startswith("--")).strip().rstrip(";")
            sql = sql.replace("%", "%%")                                  # % literal
            consultas[nombre] = re.sub(r"(?<![:\w]):([a-z_]+)", r"%(\1)s", sql)   # :param → %(param)s
    for linea in open(ruta, encoding="utf-8").read().splitlines():
        m = re.match(r"--\s*name:\s*(\w+)", linea)
        if m:
            guardar(); nombre, lineas = m.group(1), []
        elif nombre:
            lineas.append(linea)
    guardar()
    return consultas


DEL_ASISTENTE = cargar_consultas(ARGS.consultas)
DE_INGESTION = cargar_consultas(ARGS.ingestion)
CONSULTAS = {**DEL_ASISTENTE, **DE_INGESTION}


USADAS = set()


def Q(nombre):
    USADAS.add(nombre)
    return CONSULTAS[nombre]


def P(**parametros):
    """Parámetros de una consulta. 'ahora' es el reloj de la aplicación."""
    parametros.setdefault("ahora", datetime.now(timezone.utc))
    parametros.setdefault("max_por_clinica", 1000)
    parametros.setdefault("oferta_slots", None)            # solo las ofertas de horarios llevan valor        # tope de equidad del reclamo; alto = sin efecto
    return parametros


decir(f"Esquema:   {ARGS.esquema}\n           sha256 {huella(ARGS.esquema)}")
decir(f"Consultas: {ARGS.consultas}\n           sha256 {huella(ARGS.consultas)}  ({len(DEL_ASISTENTE)} sentencias con nombre)")
decir(f"Ingestión: {ARGS.ingestion}\n           sha256 {huella(ARGS.ingestion)}  ({len(DE_INGESTION)} sentencias con nombre)\n")


def conectar(db="verificacion", autocommit=False):
    c = psycopg2.connect(f"{DSN} dbname={db}")
    c.set_session(isolation_level="READ COMMITTED", autocommit=autocommit)     # contrato: ver consultas.sql, AISLAMIENTO
    return c


def comprobar(nombre, ok, detalle=""):
    resultados.append((nombre, ok))
    decir(("  OK    " if ok else "  FALLA ") + nombre + (f"  [{detalle}]" if detalle else ""))


def debe_fallar(nombre, sql, params=None, error=errors.CheckViolation):
    c = conectar()
    try:
        c.cursor().execute(sql, params)
        c.commit()
        comprobar(nombre, False, "la base lo aceptó")
    except error:
        comprobar(nombre, True)
    except Exception as e:  # otro error: también es un fallo de la prueba
        comprobar(nombre, False, type(e).__name__)
    finally:
        c.close()


# --------------------------------------------------------------------------
# Preparación
# --------------------------------------------------------------------------
adm = conectar("postgres", autocommit=True)
cur = adm.cursor()
cur.execute("DROP DATABASE IF EXISTS verificacion WITH (FORCE)")   # cierra sesiones que hayan quedado de una ejecución interrumpida
cur.execute("CREATE DATABASE verificacion")
cur.execute("SELECT count(*) FROM pg_available_extensions WHERE name='vector'")
hay_vector = cur.fetchone()[0] == 1
adm.close()

esquema = open(ARGS.esquema, encoding="utf-8").read()
if not hay_vector:
    esquema = esquema.replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
    esquema = esquema.replace("vector(1536)", "text")
c = conectar(autocommit=True)
c.cursor().execute(esquema)
# Migraciones posteriores (002_..., 003_...) que estén junto al esquema, en orden.
import glob
for _ruta in sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(ARGS.esquema)), "[0-9][0-9][0-9]_*.sql"))):
    if os.path.abspath(_ruta) != os.path.abspath(ARGS.esquema):
        c.cursor().execute(open(_ruta, encoding="utf-8").read())
        decir(f"Migración: {_ruta}\n           sha256 {huella(_ruta)}")
decir(f"Esquema aplicado (pgvector {'presente' if hay_vector else 'ausente: columna sustituida'})\n")

cur = c.cursor()
cur.execute("INSERT INTO clinicas (nombre) VALUES ('Clínica Demo') RETURNING id"); CLIN = cur.fetchone()[0]
cur.execute("INSERT INTO sedes (clinica_id,nombre) VALUES (%s,'Norte'),(%s,'Sur') RETURNING id", (CLIN, CLIN))
SEDES = [r[0] for r in cur.fetchall()]
cur.execute("INSERT INTO especialidades (clinica_id,nombre) VALUES (%s,'dermatologia'),(%s,'nutricion'),(%s,'pediatria') RETURNING id", (CLIN,) * 3)
ESPS = [r[0] for r in cur.fetchall()]
cur.execute("""INSERT INTO profesionales (clinica_id, sede_id, especialidad_id, nombre)
               SELECT %s, s, e, 'Dr. ' || s || '-' || e || '-' || n
               FROM unnest(%s::bigint[]) s, unnest(%s::bigint[]) e, generate_series(1,8) n""", (CLIN, SEDES, ESPS))
# Dos semanas de agenda: horarios de 30 minutos, 8 horas al día
cur.execute("""INSERT INTO slots (clinica_id, profesional_id, inicia_en, termina_en)
               SELECT p.clinica_id, p.id, d + h * interval '30 minutes', d + (h+1) * interval '30 minutes'
               FROM profesionales p,
                    generate_series(date_trunc('day', now()) + interval '1 day 13 hours',
                                    date_trunc('day', now()) + interval '14 days 13 hours',
                                    interval '1 day') d,
                    generate_series(0,15) h""")
cur.execute("SELECT count(*) FROM slots"); print(f"Agenda de prueba: {cur.fetchone()[0]} horarios")


def nueva_conversacion(tel):
    cur.execute("INSERT INTO conversaciones (clinica_id, telefono) VALUES (%s,%s) RETURNING id", (CLIN, tel))
    return cur.fetchone()[0]


def nueva_oferta(mid, conv, slots):
    cur.execute("""INSERT INTO mensajes_entrantes
        (message_id, conversacion_id, texto, enviado_en, estado, intento_actual, intento_valido, respuesta_tipo, respuesta_texto, oferta_slots)
        VALUES (%s,%s,'ofrecer',now(),'procesado',1,1,'oferta_horarios','lista numerada',%s::bigint[])""", (mid, conv, slots))


def nuevo_mensaje(mid, conv, desfase_s=0, espera_s=0, oferta=None):
    if oferta is not None:
        nueva_oferta(mid + '.oferta', conv, oferta)
    cur.execute("""INSERT INTO mensajes_entrantes (message_id, conversacion_id, texto, enviado_en, proximo_intento_en)
                   VALUES (%s,%s,'hola', now() + %s * interval '1 second', now() + %s * interval '1 second')""",
                (mid, conv, desfase_s, espera_s))


RECLAMO = Q("reclamo_elegir")
RECHAZOS = []          # admisiones rechazadas por tope de clínica (solo ocurren bajo carrera)


class AislamientoIncorrecto(Exception):
    pass


def reclamar(conn, max_por_clinica=1000, rechazos=0):
    """Transacción de reclamo. Devuelve (message_id, conv, intento) o None."""
    k = conn.cursor()
    k.execute(RECLAMO, P(max_por_clinica=max_por_clinica))
    fila = k.fetchone()
    if not fila:
        conn.commit(); return None
    k.execute(Q("reclamo_turno_clinica"), P(clinica_id=fila[2]))
    if not k.fetchone()[1]:
        conn.rollback(); raise AislamientoIncorrecto()
    k.execute(Q("reclamo_contar_clinica"), P(clinica_id=fila[2]))
    if k.fetchone()[0] >= max_por_clinica:
        conn.rollback(); RECHAZOS.append(fila[2])
        return reclamar(conn, max_por_clinica, rechazos + 1) if rechazos < 2 else None     # tras 3 rechazos, esperar
    k.execute(Q("reclamo_marcar_mensaje"), P(message_id=fila[0]))
    marcado = k.fetchone()
    if not marcado:
        conn.rollback(); return None
    k.execute(Q("reclamo_poner_candado"), P(conversacion_id=fila[1]))
    conn.commit()
    return fila[0], fila[1], marcado[0]


def cerrar(conn, mid, intento, estado_conv=None, motivo=None):
    """Transacción de cierre. Devuelve True si el cierre aplicó."""
    k = conn.cursor()
    k.execute(Q("bloquear_conversacion"), P(message_id=mid))
    conv = k.fetchone()[0]
    k.execute(Q("cierre_mensaje"), P(message_id=mid, intento=intento, estado_mensaje="procesado",
                                    respuesta_tipo="escalamiento" if estado_conv == "escalada" else "sin_informacion",
                                    respuesta_texto="x"))
    aplico = k.fetchone() is not None
    if aplico:
        k.execute(Q("cierre_conversacion"), P(conversacion_id=conv, estado_conversacion=estado_conv, motivo=motivo))
    k.execute(Q("traza_insertar"), P(message_id=mid, intento=intento, documento=json.dumps(
        {"resultado_procesamiento": "completado" if aplico else "descartado_por_intento"})))
    conn.commit()
    return aplico


def agendar(conn, mid, intento, slot):
    """Transacción de agendar_cita. La conversación y la clínica se derivan del mensaje.
    Devuelve 'creada', 'propia', 'ocupado', 'pasado', 'horario_invalido', 'oferta_no_vigente' o 'intento_vencido'."""
    k = conn.cursor()
    try:
        k.execute(Q("bloquear_conversacion"), P(message_id=mid))
        conv = k.fetchone()[0]
        k.execute(Q("verificar_intento"), P(message_id=mid, intento=intento))
        if not k.fetchone():
            conn.rollback(); return "intento_vencido"
        k.execute(Q("cita_de_mensaje"), P(message_id=mid))
        if k.fetchone():
            conn.commit(); return "propia"
        k.execute("""SELECT message_id, secuencia, oferta_slots FROM mensajes_entrantes
                     WHERE conversacion_id=%s AND oferta_slots IS NOT NULL
                     ORDER BY secuencia DESC LIMIT 1""", (conv,))
        oferta = k.fetchone()
        if not oferta or slot not in oferta[2]:
            conn.rollback(); return "oferta_no_vigente"
        autorizacion = P(slot_id=slot, conversacion_id=conv, message_id=mid,
                         oferta_message_id=oferta[0], oferta_secuencia=oferta[1], oferta_slots=oferta[2], opcion=oferta[2].index(slot) + 1)
        k.execute(Q("agendar_validar_oferta"), autorizacion)
        if not k.fetchone():
            conn.rollback(); return "oferta_no_vigente"
        k.execute(Q("agendar_clasificar_horario"), autorizacion)
        horario = k.fetchone()
        if not horario:
            conn.rollback(); return "horario_invalido"      # no existe o es de otra clínica
        if not horario[1]:
            conn.rollback(); return "pasado"
        k.execute(Q("agendar_insertar_cita"), autorizacion)
        if not k.fetchone():
            k.execute(Q("agendar_validar_oferta"), autorizacion)
            resultado = "pasado" if k.fetchone() else "oferta_no_vigente"
            conn.rollback(); return resultado
        k.execute(Q("agendar_subir_estado"), P(conversacion_id=conv))
        conn.commit(); return "creada"
    except errors.UniqueViolation:
        conn.rollback()
        k.execute(Q("cita_de_mensaje"), P(message_id=mid))
        propia = k.fetchone() is not None
        conn.commit()
        return "propia" if propia else "ocupado"


def fallar(conn, mid, intento, espera_s):
    """Transacción de fallo por infraestructura. Devuelve True si aplicó."""
    k = conn.cursor()
    k.execute(Q("bloquear_conversacion"), P(message_id=mid))
    conv = k.fetchone()[0]
    datos = P(message_id=mid, intento=intento, conversacion_id=conv)
    datos["proximo_intento_en"] = datos["ahora"] + __import__("datetime").timedelta(seconds=espera_s)
    k.execute(Q("fallo_mensaje"), datos)
    aplico = k.fetchone() is not None
    if aplico:
        k.execute(Q("fallo_liberar_candado"), datos)
    k.execute(Q("traza_insertar"), dict(datos, documento=json.dumps(
        {"resultado_procesamiento": "fallido" if aplico else "descartado_por_intento", "error": "timeout del proveedor"})))
    conn.commit()
    return aplico


def tomar_traza(k):
    """Paso 'relevo_tomar'. Devuelve (message_id, intento) o None."""
    k.execute(Q("relevo_tomar"))
    f = k.fetchone()
    return f and f[:2]


# --------------------------------------------------------------------------
decir("\n1. Restricciones del esquema")
# --------------------------------------------------------------------------
conv0 = nueva_conversacion("+573000000001")
nuevo_mensaje("r.1", conv0)
debe_fallar("teléfono con formato inválido", "INSERT INTO conversaciones (clinica_id, telefono) VALUES (%s,'3001112233')", (CLIN,))
debe_fallar("teléfono repetido en la misma clínica", "INSERT INTO conversaciones (clinica_id, telefono) VALUES (%s,'+573000000001')", (CLIN,), errors.UniqueViolation)
debe_fallar("escalada sin motivo", "UPDATE conversaciones SET estado='escalada' WHERE id=%s", (conv0,))
debe_fallar("motivo sin estar escalada", "UPDATE conversaciones SET motivo_escalamiento='x' WHERE id=%s", (conv0,))
debe_fallar("estado de conversación desconocido", "UPDATE conversaciones SET estado='cerrada' WHERE id=%s", (conv0,))
debe_fallar("message_id repetido", "INSERT INTO mensajes_entrantes (message_id, conversacion_id, texto, enviado_en) VALUES ('r.1',%s,'x',now())", (conv0,), errors.UniqueViolation)
debe_fallar("texto de más de 2.000 caracteres", "INSERT INTO mensajes_entrantes (message_id, conversacion_id, texto, enviado_en) VALUES ('r.2',%s,repeat('a',2001),now())", (conv0,))
debe_fallar("procesado sin respuesta", "UPDATE mensajes_entrantes SET estado='procesado', intento_actual=1, intento_valido=1 WHERE message_id='r.1'")
debe_fallar("procesado sin intento válido", "UPDATE mensajes_entrantes SET estado='procesado', intento_actual=1, respuesta_tipo='respaldo', respuesta_texto='x' WHERE message_id='r.1'")
debe_fallar("pendiente con respuesta", "UPDATE mensajes_entrantes SET respuesta_tipo='respaldo', respuesta_texto='x' WHERE message_id='r.1'")
debe_fallar("intento válido distinto del actual", "UPDATE mensajes_entrantes SET estado='procesado', intento_actual=2, intento_valido=1, respuesta_tipo='respaldo', respuesta_texto='x' WHERE message_id='r.1'")
debe_fallar("procesando sin haber sido reclamado", "UPDATE mensajes_entrantes SET estado='procesando' WHERE message_id='r.1'")
debe_fallar("tipo de respuesta desconocido", "UPDATE mensajes_entrantes SET estado='procesado', intento_actual=1, intento_valido=1, respuesta_tipo='libre', respuesta_texto='x' WHERE message_id='r.1'")
debe_fallar("cita con mensaje inexistente", "INSERT INTO citas (clinica_id, slot_id, conversacion_id, source_message_id) SELECT clinica_id,id,%s,'no.existe' FROM slots LIMIT 1", (conv0,), errors.ForeignKeyViolation)
debe_fallar("horario duplicado del mismo profesional", "INSERT INTO slots (clinica_id, profesional_id, inicia_en, termina_en) SELECT clinica_id, profesional_id, inicia_en, termina_en FROM slots LIMIT 1", None, errors.UniqueViolation)
debe_fallar("horario que termina antes de empezar", "INSERT INTO slots (clinica_id, profesional_id, inicia_en, termina_en) SELECT clinica_id, profesional_id, inicia_en + interval '100 days', inicia_en FROM slots LIMIT 1")
debe_fallar("traza con intento 0", "INSERT INTO trazas_pendientes (message_id,intento,documento) VALUES ('r.1',0,'{}')")
debe_fallar("traza de más de 64 KB", "INSERT INTO trazas_pendientes (message_id,intento,documento) VALUES ('r.1',1, jsonb_build_object('x', repeat('a', 70000)))")

# El estado solo sube
cur.execute("UPDATE conversaciones SET estado='cita_agendada' WHERE id=%s", (conv0,))
debe_fallar("bajar el estado de cita_agendada a resuelta_por_ia", "UPDATE conversaciones SET estado='resuelta_por_ia' WHERE id=%s", (conv0,))
cur.execute("UPDATE conversaciones SET estado='escalada', motivo_escalamiento='prueba' WHERE id=%s", (conv0,))
debe_fallar("sacar una conversación de escalada", "UPDATE conversaciones SET estado='en_curso', motivo_escalamiento=NULL WHERE id=%s", (conv0,))
cur.execute("UPDATE mensajes_entrantes SET estado='procesado', intento_actual=1, intento_valido=1, respuesta_tipo='respaldo', respuesta_texto='x' WHERE message_id='r.1'")

# --------------------------------------------------------------------------
decir("\n2. Cola: orden por conversación")
# --------------------------------------------------------------------------
w1, w2 = conectar(), conectar()
convA = nueva_conversacion("+573000000010")
nuevo_mensaje("a.1", convA, desfase_s=-30)
nuevo_mensaje("a.2", convA, desfase_s=-20)
r1 = reclamar(w1)
comprobar("se reclama el mensaje más antiguo", r1 and r1[0] == "a.1", str(r1))
r2 = reclamar(w2)
comprobar("el segundo mensaje espera mientras el primero se procesa", r2 is None, str(r2))
cerrar(w1, "a.1", r1[2])
r3 = reclamar(w2)
comprobar("al cerrar el primero, se reclama el segundo", r3 and r3[0] == "a.2", str(r3))
cerrar(w2, "a.2", r3[2])

convB = nueva_conversacion("+573000000011")
nuevo_mensaje("b.1", convB, desfase_s=-30, espera_s=3600, oferta=[1, 2, 3])   # el más antiguo espera un reintento
nuevo_mensaje("b.2", convB, desfase_s=-20)
comprobar("si el más antiguo espera reintento, el posterior no se adelanta", reclamar(w1) is None)
cur.execute("UPDATE mensajes_entrantes SET proximo_intento_en = now() WHERE message_id='b.1'")
rb = reclamar(w1)
comprobar("cumplida la espera, se reclama el más antiguo", rb and rb[0] == "b.1", str(rb))

# Mensaje huérfano: el worker murió; al vencer el candado otro lo retoma
cur.execute("UPDATE conversaciones SET procesando_hasta = now() - interval '1 second' WHERE id=%s", (convB,))
rh = reclamar(w2)
comprobar("mensaje huérfano se reclama al vencer el candado, con intento 2", rh and rh[0] == "b.1" and rh[2] == 2, str(rh))

# --------------------------------------------------------------------------
decir("\n3. Protección contra el worker tardío")
# --------------------------------------------------------------------------
cur.execute("SELECT id FROM slots ORDER BY id LIMIT 3"); S1, S2, S3 = [r[0] for r in cur.fetchall()]
comprobar("worker tardío (intento 1) no puede crear cita", agendar(w1, "b.1", 1, S1) == "intento_vencido")
comprobar("worker tardío (intento 1) no puede cerrar", cerrar(w1, "b.1", 1) is False)
cur.execute("SELECT documento->>'resultado_procesamiento' FROM trazas_pendientes WHERE message_id='b.1' AND intento=1")
comprobar("el intento tardío deja traza marcada como descartada", cur.fetchone()[0] == "descartado_por_intento")
cur.execute("SELECT m.estado, c.procesando_hasta IS NOT NULL FROM mensajes_entrantes m JOIN conversaciones c ON c.id=m.conversacion_id WHERE message_id='b.1'")
comprobar("el cierre tardío no cambió el mensaje ni liberó el candado", cur.fetchone() == ("procesando", True))
comprobar("worker vigente (intento 2) crea la cita", agendar(w2, "b.1", 2, S1) == "creada")

# --------------------------------------------------------------------------
decir("\n4. Citas: idempotencia y conflicto")
# --------------------------------------------------------------------------
comprobar("reintento sobre el MISMO horario de la cita propia se reconoce como propia", agendar(w2, "b.1", 2, S1) == "propia")
comprobar("reintento sobre OTRO horario devuelve la cita propia, no crea otra", agendar(w2, "b.1", 2, S2) == "propia")
cur.execute("SELECT count(*) FROM citas WHERE source_message_id='b.1'")
comprobar("el mensaje tiene exactamente una cita", cur.fetchone()[0] == 1)
cur.execute("SELECT estado FROM conversaciones WHERE id=%s", (convB,))
comprobar("la conversación pasó a cita_agendada en la misma transacción", cur.fetchone()[0] == "cita_agendada")
cerrar(w2, "b.1", 2, "resuelta_por_ia")
cur.execute("SELECT estado FROM conversaciones WHERE id=%s", (convB,))
comprobar("un cierre con estado de menor rango no baja el estado", cur.fetchone()[0] == "cita_agendada")

convC = nueva_conversacion("+573000000012"); nuevo_mensaje("c.1", convC, oferta=[S1])
cur.execute("UPDATE mensajes_entrantes SET proximo_intento_en = now() + interval '1 hour' WHERE message_id='b.2'")
rc = reclamar(w1)
comprobar("otro paciente sobre el horario ya tomado recibe 'ocupado'", rc and agendar(w1, rc[0], rc[2], S1) == "ocupado", str(rc))
cur.execute("UPDATE citas SET estado='cancelada' WHERE slot_id=%s", (S1,))
comprobar("un horario cancelado se puede volver a reservar", agendar(w1, rc[0], rc[2], S1) == "creada")
cur.execute("SELECT id FROM slots WHERE inicia_en > now() ORDER BY id DESC LIMIT 1"); SF = cur.fetchone()[0]
cur.execute("UPDATE slots SET inicia_en = now() - interval '2 hours', termina_en = now() - interval '1 hour' WHERE id=%s", (SF,))
convD = nueva_conversacion("+573000000013"); nuevo_mensaje("d.1", convD, oferta=[SF])
rd = reclamar(w2)
comprobar("un horario pasado no se puede agendar", rd and agendar(w2, rd[0], rd[2], SF) == "pasado", str(rd))
for conn, r in ((w1, rc), (w2, rd)):
    cerrar(conn, r[0], r[2])

# La base impide asociar una cita a una conversación que no es la de su mensaje
cur.execute("SELECT id FROM slots WHERE inicia_en > now() ORDER BY id LIMIT 1 OFFSET 200"); SX = cur.fetchone()[0]
debe_fallar("cita con el mensaje de una conversación y el id de otra",
            "INSERT INTO citas (clinica_id, slot_id, conversacion_id, source_message_id) VALUES (%s,%s,%s,'a.2')", (CLIN, SX, convC), errors.ForeignKeyViolation)

# Conocimiento: el texto vive solo en documento_lineas
cur.execute("INSERT INTO clinicas (nombre) VALUES ('Otra clínica') RETURNING id"); CLIN2 = cur.fetchone()[0]
VEC = "[1" + ",0" * 1535 + "]" if hay_vector else "x"


def ingerir(clinica, titulo, huella_doc, lineas, modelo="m"):
    """Transacción de ingestión con las sentencias de ingestion.sql. Un fragmento: encabezado + resto."""
    cur.execute(Q("ingestion_huella_actual"), P(clinica_id=clinica, titulo=titulo))
    actual = cur.fetchone()
    if actual and actual[0] == huella_doc:
        return None                                   # nada cambió: no se reingiere
    cur.execute(Q("ingestion_borrar_documento"), P(clinica_id=clinica, titulo=titulo))
    cur.execute(Q("ingestion_insertar_documento"), P(clinica_id=clinica, titulo=titulo, huella=huella_doc))
    doc = cur.fetchone()[0]
    cur.execute(Q("ingestion_insertar_lineas"), P(documento_id=doc, textos=lineas))
    cur.execute(Q("ingestion_insertar_fragmento"), fragmento(doc, clinica, 1, 2, len(lineas), modelo))
    return doc


def fragmento(doc, clinica, encabezado, inicial, final, modelo="m", embedding=None):
    return P(documento_id=doc, clinica_id=clinica, linea_encabezado=encabezado, linea_inicial=inicial, linea_final=final,
             embedding=embedding or VEC, modelo=modelo)


HORARIOS = ["## Horarios", "Sede Norte: lunes a sábado, de 8:00 a. m. a 12:00 p. m.", "Sede Sur: lunes a viernes, de 7:00 a. m. a 5:00 p. m."]
DOC = ingerir(CLIN, "Horarios", "h", HORARIOS)
cur.execute("SELECT numero FROM documento_lineas WHERE documento_id=%s ORDER BY numero", (DOC,))
comprobar("ingestión: las líneas quedan numeradas 1..N por su posición", [r[0] for r in cur.fetchall()] == [1, 2, 3])
comprobar("ingestión: con la misma huella no se reingiere", ingerir(CLIN, "Horarios", "h", HORARIOS) is None)
FRAG = Q("ingestion_insertar_fragmento")
debe_fallar("fragmento en una clínica distinta de la de su documento", FRAG, fragmento(DOC, CLIN2, 1, 3, 3), errors.ForeignKeyViolation)
debe_fallar("fragmento que apunta a una línea que no existe", FRAG, fragmento(DOC, CLIN, 1, 9, 9), errors.ForeignKeyViolation)
debe_fallar("línea de documento de más de 500 caracteres", "INSERT INTO documento_lineas (documento_id, numero, texto) VALUES (%s,4,repeat('a',501))", (DOC,))
debe_fallar("editar el texto de una línea ya ingerida", "UPDATE documento_lineas SET texto='Sede Norte: lunes a domingo' WHERE documento_id=%s AND numero=2", (DOC,))
cur.execute(Q("conocimiento_armar_respuesta"), P(clinica_id=CLIN, documentos=[DOC, DOC, DOC], numeros=[3, 1, 3]))   # desordenado y con una repetida
armado = [r[2] for r in cur.fetchall()]
comprobar("la respuesta se arma con las líneas canónicas, en orden y sin repetir aunque se pidan desordenadas y duplicadas",
          armado == ["## Horarios", "Sede Sur: lunes a viernes, de 7:00 a. m. a 5:00 p. m."], str(armado))
debe_fallar("cambiar el título de un documento ya ingerido", "UPDATE documentos SET titulo='Otro' WHERE id=%s", (DOC,))
debe_fallar("cambiar la huella de un documento", "UPDATE documentos SET huella='otra' WHERE id=%s", (DOC,))
debe_fallar("modificar un fragmento", "UPDATE fragmentos_conocimiento SET linea_final=2 WHERE documento_id=%s", (DOC,))
debe_fallar("borrar una línea suelta de un documento", "DELETE FROM documento_lineas WHERE documento_id=%s AND numero=3", (DOC,))
cur.execute("SELECT count(*) FROM fragmentos_conocimiento WHERE documento_id=%s", (DOC,))
comprobar("el intento de borrar una línea no destruyó el fragmento", cur.fetchone()[0] == 1)
cur.execute("SELECT count(*) FROM fragmentos_conocimiento WHERE clinica_id=%s AND modelo_embedding='otro-modelo'", (CLIN,))
comprobar("la búsqueda filtrada por otro modelo de embeddings no devuelve fragmentos", cur.fetchone()[0] == 0)
cur.execute("SELECT DISTINCT modelo_embedding FROM fragmentos_conocimiento WHERE clinica_id=%s AND modelo_embedding <> 'm'", (CLIN,))
comprobar("comprobación de arranque: no hay fragmentos de un modelo distinto del configurado", cur.fetchall() == [])
cur.execute("INSERT INTO sedes (clinica_id, nombre) VALUES (%s,'Centro') RETURNING id", (CLIN2,)); SEDE2 = cur.fetchone()[0]
debe_fallar("profesional con sede de una clínica y especialidad de otra",
            "INSERT INTO profesionales (clinica_id, sede_id, especialidad_id, nombre) VALUES (%s,%s,%s,'x')", (CLIN2, SEDE2, ESPS[0]), errors.ForeignKeyViolation)
# Cadena de clínica: una conversación de una clínica no puede agendar en la agenda de otra
cur.execute("INSERT INTO especialidades (clinica_id, nombre) VALUES (%s,'dermatologia') RETURNING id", (CLIN2,)); ESP2 = cur.fetchone()[0]
cur.execute("INSERT INTO profesionales (clinica_id, sede_id, especialidad_id, nombre) VALUES (%s,%s,%s,'Dra. Otra') RETURNING id", (CLIN2, SEDE2, ESP2)); PROF2 = cur.fetchone()[0]
cur.execute("""INSERT INTO slots (clinica_id, profesional_id, inicia_en, termina_en)
               VALUES (%s,%s, now() + interval '3 days', now() + interval '3 days 30 minutes') RETURNING id""", (CLIN2, PROF2)); SLOT2 = cur.fetchone()[0]
convY = nueva_conversacion("+573000000016"); nuevo_mensaje("y.1", convY, espera_s=86400)   # mensaje sin cita, para forzar inserciones
debe_fallar("horario con la clínica cambiada respecto a su profesional",
            "INSERT INTO slots (clinica_id, profesional_id, inicia_en, termina_en) VALUES (%s,%s, now() + interval '5 days', now() + interval '5 days 30 minutes')", (CLIN, PROF2), errors.ForeignKeyViolation)
debe_fallar("cita forzada: conversación de una clínica en un horario de otra",
            "INSERT INTO citas (clinica_id, slot_id, conversacion_id, source_message_id) VALUES (%s,%s,%s,'y.1')", (CLIN, SLOT2, convY), errors.ForeignKeyViolation)
debe_fallar("cita forzada con la clínica del horario y la conversación de otra",
            "INSERT INTO citas (clinica_id, slot_id, conversacion_id, source_message_id) VALUES (%s,%s,%s,'y.1')", (CLIN2, SLOT2, convY), errors.ForeignKeyViolation)
convX = nueva_conversacion("+573000000015"); nuevo_mensaje("x.1", convX, oferta=[SLOT2, 999999999])
rx = reclamar(w1)
comprobar("agendar_cita con un horario de otra clínica: 'horario_invalido', no 'pasado'", rx and rx[0] == "x.1" and agendar(w1, "x.1", rx[2], SLOT2) == "horario_invalido", str(rx))
comprobar("agendar_cita con un horario inexistente: 'horario_invalido'", agendar(w1, "x.1", rx[2], 999999999) == "horario_invalido")

# Lectura de disponibilidad: filtrada por la clínica del contexto
def disponibles(clinica, especialidad):
    cur.execute(Q("disponibilidad"), P(clinica_id=clinica, especialidad_id=especialidad, sede_id=None,
                                       desde=datetime(2000, 1, 1, tzinfo=timezone.utc), hasta=datetime(2100, 1, 1, tzinfo=timezone.utc)))
    return [r[0] for r in cur.fetchall()]


comprobar("disponibilidad: con la clínica A y una especialidad de la clínica B no devuelve nada", disponibles(CLIN, ESP2) == [])
comprobar("disponibilidad: la clínica B sí ve su propio horario", disponibles(CLIN2, ESP2) == [SLOT2])

# Estado del conocimiento por clínica, derivado de sus fragmentos
def estado_conocimiento(modelo, clinica):
    cur.execute(Q("conocimiento_estado"), P(modelo=modelo, clinica_id=clinica)); return cur.fetchone()[0]


estados = [estado_conocimiento("m", CLIN), estado_conocimiento("otro-modelo", CLIN), estado_conocimiento("m", CLIN2)]
comprobar("estado del conocimiento distingue listo, desactualizado y sin indexar", estados == ["listo", "desactualizado", "sin_indexar"], str(estados))
# Reindexación a medias: un segundo documento de la misma clínica, indexado con otro modelo
DOCP = ingerir(CLIN, "Sedes", "h2", ["## Sedes", "Sede Norte: calle 10 # 5-20"], modelo="modelo-viejo")
comprobar("estado del conocimiento: una clínica indexada a medias es 'parcial', no 'listo'", estado_conocimiento("m", CLIN) == "parcial", estado_conocimiento("m", CLIN))
cur.execute(Q("ingestion_borrar_documento"), P(clinica_id=CLIN, titulo="Sedes"))
comprobar("tras reingerir el documento pendiente, la clínica vuelve a 'listo'", estado_conocimiento("m", CLIN) == "listo")
cur.execute(Q("conocimiento_estado_por_clinica"), P(modelo="m"))
comprobar("comprobación de arranque: totales y actuales por clínica", [f for f in cur.fetchall() if f[0] == CLIN] == [(CLIN, 1, 1)])
cur.execute(Q("conocimiento_armar_respuesta"), P(clinica_id=CLIN2, documentos=[DOC], numeros=[2]))
comprobar("armar una respuesta con líneas de otra clínica: vacío", cur.fetchall() == [])
# El horario deja de ser futuro entre la clasificación y la inserción: la inserción se protege sola
cur.execute("SELECT id FROM slots WHERE inicia_en > now() ORDER BY id LIMIT 1 OFFSET 400"); SLIM = cur.fetchone()[0]
convT = nueva_conversacion("+573000000018"); nuevo_mensaje("t.1", convT, oferta=[SLIM])
cur.execute("SELECT secuencia FROM mensajes_entrantes WHERE message_id='t.1.oferta'"); sec_oferta = cur.fetchone()[0]
despues = P(slot_id=SLIM, conversacion_id=convT, message_id="t.1", oferta_message_id="t.1.oferta",
            oferta_secuencia=sec_oferta, oferta_slots=[SLIM], opcion=1)
despues["ahora"] = datetime(2100, 1, 1, tzinfo=timezone.utc)      # el reloj ya pasó la hora del horario
cur.execute(Q("agendar_insertar_cita"), despues)
comprobar("la inserción de la cita no crea nada si el horario ya no es futuro", cur.fetchone() is None)
cur.execute("UPDATE mensajes_entrantes SET proximo_intento_en = now() + interval '1 day' WHERE message_id='t.1'")
cur.execute("SELECT count(*) FROM citas WHERE source_message_id='x.1'")
comprobar("no quedó ninguna cita cruzada entre clínicas", cur.fetchone()[0] == 0)
cerrar(w1, "x.1", rx[2])

cur.execute(Q("ingestion_borrar_documento"), P(clinica_id=CLIN, titulo="Horarios"))
cur.execute("SELECT (SELECT count(*) FROM documento_lineas WHERE documento_id=%s) + (SELECT count(*) FROM fragmentos_conocimiento WHERE documento_id=%s)", (DOC, DOC))
comprobar("reingerir: al borrar el documento desaparecen juntas sus líneas y fragmentos", cur.fetchone()[0] == 0)

# Un mensaje es inmutable: solo cambian sus campos operativos
for campo, valor in (("texto", "'otro texto'"), ("conversacion_id", str(convC)), ("enviado_en", "now() - interval '1 day'"),
                     ("recibido_en", "now() - interval '1 day'"), ("message_id", "'a.1.bis'")):
    debe_fallar(f"modificar {campo} de un mensaje", f"UPDATE mensajes_entrantes SET {campo} = {valor} WHERE message_id='a.1'")

# Un mensaje terminado no cambia en nada
debe_fallar("cambiar la respuesta de un mensaje ya terminado", "UPDATE mensajes_entrantes SET respuesta_texto='otra respuesta' WHERE message_id='a.1'")
debe_fallar("devolver a la cola un mensaje ya terminado", "UPDATE mensajes_entrantes SET estado='pendiente', intento_valido=NULL, respuesta_tipo=NULL, respuesta_texto=NULL WHERE message_id='a.1'")
debe_fallar("respuesta de más de 4.096 caracteres", "UPDATE mensajes_entrantes SET estado='procesado', intento_actual=1, intento_valido=1, respuesta_tipo='respaldo', respuesta_texto=repeat('a',4097) WHERE message_id='b.2'")

# Agenda: un profesional no puede tener horarios que se solapen
debe_fallar("horario solapado con otro del mismo profesional",
            "INSERT INTO slots (clinica_id, profesional_id, inicia_en, termina_en) SELECT clinica_id, profesional_id, inicia_en + interval '10 minutes', termina_en + interval '10 minutes' FROM slots ORDER BY id LIMIT 1",
            None, errors.ExclusionViolation)

# Orden operativo: lo define el servidor al recibir, no la hora que trae el mensaje
convO = nueva_conversacion("+573000000014")
nuevo_mensaje("o.1", convO, desfase_s=0)
nuevo_mensaje("o.2", convO, desfase_s=-3600)     # llega después, pero dice haberse enviado una hora antes
ro = reclamar(w1)
comprobar("el orden lo define la llegada al servidor, no la hora que declara el mensaje", ro and ro[0] == "o.1", str(ro))

# Un worker tardío tampoco puede escalar la conversación
cur.execute("UPDATE conversaciones SET procesando_hasta = now() - interval '1 second' WHERE id=%s", (convO,))
ro2 = reclamar(w2)                                # otro worker retoma: intento 2
comprobar("worker tardío no puede escalar la conversación", cerrar(w1, "o.1", 1, "escalada", "tardío") is False)
cur.execute("SELECT estado FROM conversaciones WHERE id=%s", (convO,))
comprobar("la conversación sigue sin escalar tras el intento tardío", cur.fetchone()[0] == "en_curso")
cerrar(w2, "o.1", ro2[2], "escalada", "el modelo pidió un asesor")
cur.execute("SELECT c.estado, c.motivo_escalamiento, m.respuesta_tipo FROM conversaciones c JOIN mensajes_entrantes m ON m.conversacion_id=c.id WHERE m.message_id='o.1'")
comprobar("el worker vigente escala: estado, motivo y respuesta quedan en el mismo cierre", cur.fetchone() == ("escalada", "el modelo pidió un asesor", "escalamiento"))
cur.execute("UPDATE mensajes_entrantes SET proximo_intento_en = now() + interval '1 day' WHERE message_id='o.2'")

# El reclamo no revive un mensaje ya terminado
k = w1.cursor()
k.execute(Q("reclamo_marcar_mensaje"), P(message_id="a.1"))
comprobar("el reclamo no puede revivir un mensaje ya terminado", k.fetchone() is None); w1.rollback()

# Fallo por infraestructura: el mensaje vuelve a la cola con espera
convF = nueva_conversacion("+573000000017"); nuevo_mensaje("f.1", convF); nuevo_mensaje("f.2", convF)
rf = reclamar(w1)
comprobar("fallo de infraestructura: el intento vigente devuelve el mensaje a la cola", rf and rf[0] == "f.1" and fallar(w1, "f.1", rf[2], 3600) is True, str(rf))
cur.execute("SELECT m.estado, m.intento_actual, c.procesando_hasta IS NULL FROM mensajes_entrantes m JOIN conversaciones c ON c.id=m.conversacion_id WHERE m.message_id='f.1'")
comprobar("tras el fallo: pendiente, conserva su número de intento y el candado queda libre", cur.fetchone() == ("pendiente", 1, True))
comprobar("mientras espera el reintento, ni él ni el mensaje posterior se reclaman", reclamar(w2) is None)
comprobar("un fallo reportado por un intento que ya no es el vigente no aplica", fallar(w1, "f.1", 7, 0) is False)
cur.execute(Q("detalle_mensajes"), P(conversacion_id=convF))
comprobar("el detalle lista los mensajes en el orden en que llegaron", [f[0] for f in cur.fetchall()] == ["f.1", "f.2"])
cur.execute(Q("detalle_trazas_en_outbox"), P(conversacion_id=convF))
comprobar("el intento fallido dejó su traza con el error, y el que ya no era vigente quedó como descartado", [(f[1], f[2]["resultado_procesamiento"]) for f in cur.fetchall()] == [(1, "fallido"), (7, "descartado_por_intento")])

# --------------------------------------------------------------------------
decir("\n4b. Orden de bloqueos: worker tardío agendando mientras otro reclama")
# --------------------------------------------------------------------------
# Carrera: el worker nuevo ya bloqueó la conversación (primer paso del reclamo)
# cuando el worker viejo entra a agendar. Con un orden inconsistente esto es un
# deadlock; con conversación -> mensaje, el viejo espera y luego ve su intento vencido.
bloqueos = []
for i in range(15):
    cv = nueva_conversacion(f"+5733000000{i:02d}"); mid = f"bloqueo.{i}"; nuevo_mensaje(mid, cv)
    cur.execute("UPDATE mensajes_entrantes SET estado='procesando', intento_actual=1 WHERE message_id=%s", (mid,))
    cur.execute("UPDATE conversaciones SET procesando_hasta = now() - interval '1 second' WHERE id=%s", (cv,))
    cur.execute("SELECT id FROM slots WHERE inicia_en > now() ORDER BY id LIMIT 1 OFFSET %s", (300 + i,)); sl = cur.fetchone()[0]
    nuevo, viejo, salida_v = conectar(), conectar(), {}
    kn = nuevo.cursor()
    kn.execute("SELECT id FROM conversaciones WHERE id=%s FOR UPDATE", (cv,))        # reclamo, paso 1

    def tardio():
        try: salida_v["r"] = agendar(viejo, mid, 1, sl)
        except Exception as e: viejo.rollback(); salida_v["r"] = type(e).__name__
    h = threading.Thread(target=tardio); h.start(); time.sleep(0.05)
    try:
        kn.execute(Q("reclamo_marcar_mensaje"), P(message_id=mid))
        kn.execute(Q("reclamo_poner_candado"), P(conversacion_id=cv))
        nuevo.commit(); r_nuevo = "confirmó"
    except Exception as e:
        nuevo.rollback(); r_nuevo = type(e).__name__
    h.join(); bloqueos.append((r_nuevo, salida_v["r"])); nuevo.close(); viejo.close()
    cur.execute("UPDATE mensajes_entrantes SET proximo_intento_en = now() + interval '1 day' WHERE message_id=%s", (mid,))
comprobar("15 carreras reclamo/agendar: ningún deadlock; el tardío queda con intento vencido",
          all(b == ("confirmó", "intento_vencido") for b in bloqueos), str(set(bloqueos)))

# --------------------------------------------------------------------------
decir("\n5. Concurrencia real")
# --------------------------------------------------------------------------
# 5a. Veinte pacientes piden el mismo horario al mismo tiempo
N = 20
datos = []
for i in range(N):
    cv = nueva_conversacion(f"+5731000000{i:02d}"); nuevo_mensaje(f"carrera.{i}", cv, oferta=[S3])
    cur.execute("UPDATE mensajes_entrantes SET estado='procesando', intento_actual=1 WHERE message_id=%s", (f"carrera.{i}",))
    datos.append((f"carrera.{i}", cv))
salida, barrera = [], threading.Barrier(N)


def competir(mid, cv):
    k = conectar(); barrera.wait(); salida.append(agendar(k, mid, 1, S3)); k.close()


hilos = [threading.Thread(target=competir, args=d) for d in datos]
[h.start() for h in hilos]; [h.join() for h in hilos]
cur.execute("SELECT count(*) FROM citas WHERE slot_id=%s AND estado='agendada'", (S3,))
n_citas = cur.fetchone()[0]
comprobar(f"{N} pacientes simultáneos sobre un horario: exactamente una cita",
          n_citas == 1 and salida.count("creada") == 1 and salida.count("ocupado") == N - 1,
          f"creada={salida.count('creada')} ocupado={salida.count('ocupado')}")
cur.execute("UPDATE mensajes_entrantes SET estado='procesado', intento_valido=1, respuesta_tipo='respaldo', respuesta_texto='x' WHERE message_id LIKE 'carrera.%' AND estado='procesando'")

# Consumo de una oferta: dos transacciones y dos slots distintos, misma conversación.
cv_of = nueva_conversacion("+573600000001")
cur.execute("SELECT id FROM slots WHERE inicia_en > now() AND id NOT IN (SELECT slot_id FROM citas WHERE estado='agendada') ORDER BY id LIMIT 3 OFFSET 500")
sl_of = [r[0] for r in cur.fetchall()]
nueva_oferta("of.O1", cv_of, sl_of)
nuevo_mensaje("of.a", cv_of); nuevo_mensaje("of.b", cv_of)
cur.execute("SELECT secuencia FROM mensajes_entrantes WHERE message_id='of.O1'"); sec_of = cur.fetchone()[0]
permiso_of = P(conversacion_id=cv_of, oferta_message_id="of.O1", oferta_secuencia=sec_of, oferta_slots=sl_of)
salida_of, barrera_of = [], threading.Barrier(2)

def consumir_of(mid, posicion):
    conn = conectar(); k = conn.cursor(); barrera_of.wait()
    k.execute(Q("bloquear_conversacion"), P(message_id=mid))
    k.execute(Q("agendar_insertar_cita"), dict(permiso_of, message_id=mid, opcion=posicion, slot_id=sl_of[posicion - 1]))
    salida_of.append(k.fetchone() is not None); conn.commit(); conn.close()

hilos_of = [threading.Thread(target=consumir_of, args=("of.a",1)), threading.Thread(target=consumir_of, args=("of.b",2))]
[h.start() for h in hilos_of]; [h.join() for h in hilos_of]
comprobar("misma oferta y slots distintos bajo concurrencia: solo una cita", sorted(salida_of) == [False, True])
cur.execute("UPDATE citas SET estado='cancelada' WHERE conversacion_id=%s", (cv_of,))
nuevo_mensaje("of.c", cv_of)
cur.execute(Q("agendar_insertar_cita"), dict(permiso_of, message_id="of.c", opcion=3, slot_id=sl_of[2]))
comprobar("cancelar la cita no revive la oferta consumida", cur.fetchone() is None)
nueva_oferta("of.O2", cv_of, sl_of[::-1]); nuevo_mensaje("of.d", cv_of)
cur.execute(Q("agendar_insertar_cita"), dict(permiso_of, message_id="of.d", opcion=3, slot_id=sl_of[2]))
comprobar("una oferta posterior impide volver a O1", cur.fetchone() is None)
cur.execute("SELECT secuencia FROM mensajes_entrantes WHERE message_id='of.O2'"); sec_o2 = cur.fetchone()[0]
permiso_o2 = dict(permiso_of, oferta_message_id="of.O2", oferta_secuencia=sec_o2, oferta_slots=sl_of[::-1], message_id="of.d", opcion=1, slot_id=sl_of[2])
for campo, valor in (("oferta_secuencia", sec_o2 - 1), ("oferta_slots", sl_of), ("opcion", 2), ("slot_id", sl_of[1])):
    cur.execute(Q("agendar_insertar_cita"), dict(permiso_o2, **{campo: valor}))
    comprobar("INSERT rechaza identidad/posición alterada: " + campo, cur.fetchone() is None)
cur.execute(Q("agendar_insertar_cita"), permiso_o2)
comprobar("una nueva oferta y otra selección crean una segunda cita legítima", cur.fetchone() is not None)
cur.execute("UPDATE mensajes_entrantes SET proximo_intento_en = now() + interval '1 day' WHERE message_id LIKE 'of.%' AND estado='pendiente'")

# Oferta en espera de selección: se deriva del tipo de las respuestas posteriores.
def turno_terminado(mid, conv, tipo):
    cur.execute("""INSERT INTO mensajes_entrantes
        (message_id, conversacion_id, texto, enviado_en, estado, intento_actual, intento_valido, respuesta_tipo, respuesta_texto)
        VALUES (%s,%s,'x',now(),'procesado',1,1,%s,'y')""", (mid, conv, tipo))

def oferta_en_espera(prefijo, tipos_posteriores):
    cv = nueva_conversacion("+5737" + f"{abs(hash(prefijo)) % 10**8:08d}")
    nueva_oferta(prefijo + ".O", cv, sl_of)
    for i, tipo in enumerate(tipos_posteriores):
        turno_terminado(f"{prefijo}.t{i}", cv, tipo)
    nuevo_mensaje(prefijo + ".x", cv)
    cur.execute("SELECT secuencia FROM mensajes_entrantes WHERE message_id=%s", (prefijo + ".O",)); sec = cur.fetchone()[0]
    cur.execute(Q("agendar_validar_oferta"), P(conversacion_id=cv, oferta_message_id=prefijo + ".O", oferta_secuencia=sec,
                                             oferta_slots=sl_of, message_id=prefijo + ".x", opcion=1, slot_id=sl_of[0]))
    vale = cur.fetchone() is not None
    cur.execute("UPDATE mensajes_entrantes SET proximo_intento_en = now() + interval '1 day' WHERE message_id=%s", (prefijo + ".x",))
    return vale

comprobar("oferta en espera: sin respuestas posteriores, vale", oferta_en_espera("esp.a", []))
comprobar("oferta en espera: respuestas documentales y 'sin información' posteriores no la anulan",
          oferta_en_espera("esp.b", ["respuesta_documental", "sin_informacion", "respuesta_documental"]))
for tipo in ("pregunta_aclaratoria", "sin_disponibilidad", "confirmacion_cita", "escalamiento", "respaldo"):
    comprobar("oferta en espera: una respuesta posterior de tipo " + tipo + " la anula", not oferta_en_espera("esp." + tipo, [tipo]))
comprobar("oferta en espera: una pregunta al paciente la anula aunque después haya respuestas documentales",
          not oferta_en_espera("esp.c", ["pregunta_aclaratoria", "respuesta_documental"]))

# 5b. Ocho workers vacían una cola de 60 conversaciones con 3 mensajes cada una
cur.execute("UPDATE mensajes_entrantes SET proximo_intento_en = now() + interval '1 day' WHERE estado IN ('pendiente','procesando')")
cur.execute("UPDATE conversaciones SET procesando_hasta = NULL")
for i in range(60):
    cv = nueva_conversacion(f"+5732000000{i:02d}")
    for j in range(3):
        nuevo_mensaje(f"cola.{i}.{j}", cv, desfase_s=-100 + j)
registro, cerrojo, activos, violaciones = [], threading.Lock(), set(), []


def trabajar():
    k = conectar()
    vacios = 0
    while vacios < 5:
        r = reclamar(k)
        if not r:
            vacios += 1; time.sleep(0.02); continue
        vacios = 0
        with cerrojo:
            if r[1] in activos: violaciones.append(r)
            activos.add(r[1]); registro.append(r[0])
        time.sleep(0.005)                       # "procesa"
        with cerrojo: activos.discard(r[1])
        cerrar(k, r[0], r[2])
    k.close()


hilos = [threading.Thread(target=trabajar) for _ in range(8)]
[h.start() for h in hilos]; [h.join() for h in hilos]
en_orden = all(registro.index(f"cola.{i}.0") < registro.index(f"cola.{i}.1") < registro.index(f"cola.{i}.2") for i in range(60))
comprobar("8 workers: los 180 mensajes se procesan exactamente una vez", len(registro) == 180 and len(set(registro)) == 180, f"{len(registro)} reclamos")
comprobar("8 workers: nunca dos a la vez en la misma conversación", not violaciones, f"{len(violaciones)} violaciones")
comprobar("8 workers: cada conversación en su orden", en_orden)
# Equidad entre clínicas: el atraso de una no deja esperando a las demás
for i in range(5):
    cv = nueva_conversacion(f"+5734000000{i:02d}"); nuevo_mensaje(f"equidad.a.{i}", cv)
    cur.execute("UPDATE mensajes_entrantes SET proximo_intento_en = now() - interval '10 minutes' WHERE message_id=%s", (f"equidad.a.{i}",))
cur.execute("INSERT INTO conversaciones (clinica_id, telefono) VALUES (%s,'+573400000099') RETURNING id", (CLIN2,)); cvB = cur.fetchone()[0]
nuevo_mensaje("equidad.b.0", cvB)                    # llegó después que los cinco de la clínica A
orden = [reclamar(w1, max_por_clinica=2) for _ in range(4)]
tomados = [r[0] if r else None for r in orden]
comprobar("equidad: con tope de 2 por clínica, tras dos de la clínica atrasada se atiende a la otra",
          tomados == ["equidad.a.0", "equidad.a.1", "equidad.b.0", None], str(tomados))
cerrar(w1, "equidad.a.0", 1)
siguiente = reclamar(w1, max_por_clinica=2)
comprobar("equidad: al terminar una conversación, la clínica atrasada recupera su turno", siguiente and siguiente[0] == "equidad.a.2", str(siguiente))
for mid, intento in (("equidad.a.1", 1), ("equidad.b.0", 1), ("equidad.a.2", 1)):
    cerrar(w1, mid, intento)
while True:
    r = reclamar(w1)
    if not r: break
    cerrar(w1, r[0], r[2])

# Presupuesto por clínica bajo concurrencia real: 20 workers arrancan a la vez
cur.execute("UPDATE mensajes_entrantes SET proximo_intento_en = now() + interval '1 day' WHERE estado IN ('pendiente','procesando')")
cur.execute("UPDATE conversaciones SET procesando_hasta = NULL")
CARRERA = {}
for nombre in "AB":
    cur.execute("INSERT INTO clinicas (nombre) VALUES (%s) RETURNING id", (f"Carrera {nombre}",)); cl = cur.fetchone()[0]
    for i in range(20):
        cur.execute("INSERT INTO conversaciones (clinica_id, telefono) VALUES (%s,%s) RETURNING id", (cl, f"+5735{ord(nombre)}000{i:02d}")); cv = cur.fetchone()[0]
        CARRERA[cv] = cl
        for j in range(2):
            nuevo_mensaje(f"carrera.{nombre}.{i}.{j}", cv, desfase_s=-50 + j)
N = 20; barrera = threading.Barrier(N); RECHAZOS.clear()


def tomar_uno():
    k = conectar(); barrera.wait(); reclamar(k, max_por_clinica=2); k.close()


hilos = [threading.Thread(target=tomar_uno) for _ in range(N)]
[h.start() for h in hilos]; [h.join() for h in hilos]
cur.execute("SELECT count(*) FROM conversaciones WHERE procesando_hasta >= now() AND clinica_id = ANY(%s) GROUP BY clinica_id", (list(set(CARRERA.values())),))
por_clinica = sorted(r[0] for r in cur.fetchall())
comprobar("presupuesto por clínica: 20 reclamos simultáneos, tope 2, quedan exactamente 2 por clínica", por_clinica == [2, 2],
          f"en proceso {por_clinica}, admisiones rechazadas por carrera {len(RECHAZOS)}")

mal = conectar(); mal.set_session(isolation_level="REPEATABLE READ")
cur.execute("UPDATE conversaciones SET procesando_hasta = NULL WHERE id = ANY(%s)", (list(CARRERA),))
cur.execute("UPDATE mensajes_entrantes SET estado='pendiente' WHERE conversacion_id = ANY(%s) AND estado='procesando'", (list(CARRERA),))
try:
    reclamar(mal, max_por_clinica=2); rechazado = False
except AislamientoIncorrecto:
    rechazado = True
cur.execute("SELECT count(*) FROM conversaciones WHERE procesando_hasta IS NOT NULL AND id = ANY(%s)", (list(CARRERA),))
comprobar("aislamiento: un reclamo en REPEATABLE READ se rechaza y no toma nada", rechazado and cur.fetchone()[0] == 0)
mal.close()
cur.execute("SHOW transaction_isolation")
comprobar("aislamiento: las conexiones del verificador declaran READ COMMITTED de forma explícita", cur.fetchone()[0] == "read committed")

# Lo mismo con rotación: 20 workers reclaman, procesan y cierran hasta vaciar; se vigila el máximo
activos_cl, maximo_cl, hechos, fin = {}, {}, [], threading.Event()
maximo_bd = [0]


def vigilar():
    v = conectar(autocommit=True); kv = v.cursor()
    while not fin.is_set():
        kv.execute("SELECT coalesce(max(n),0) FROM (SELECT count(*) n FROM conversaciones WHERE procesando_hasta IS NOT NULL AND clinica_id = ANY(%s) GROUP BY clinica_id) x", (list(set(CARRERA.values())),))
        maximo_bd[0] = max(maximo_bd[0], kv.fetchone()[0])
    v.close()


def rotar():
    k = conectar(); barrera.wait(); vacios = 0
    while vacios < 20:
        r = reclamar(k, max_por_clinica=2)
        if not r:
            vacios += 1; time.sleep(0.005); continue
        vacios = 0; cl = CARRERA[r[1]]
        with cerrojo:
            activos_cl[cl] = activos_cl.get(cl, 0) + 1; maximo_cl[cl] = max(maximo_cl.get(cl, 0), activos_cl[cl])
        time.sleep(0.003)
        with cerrojo: activos_cl[cl] -= 1; hechos.append(r[0])
        cerrar(k, r[0], r[2])
    k.close()


barrera = threading.Barrier(N); vigia = threading.Thread(target=vigilar); vigia.start()
hilos = [threading.Thread(target=rotar) for _ in range(N)]
[h.start() for h in hilos]; [h.join() for h in hilos]; fin.set(); vigia.join()
comprobar("presupuesto por clínica con rotación: 20 workers vacían 80 mensajes de 2 clínicas sin pasar nunca de 2 por clínica",
          len(hechos) == 80 and len(set(hechos)) == 80 and max(maximo_cl.values()) <= 2 and maximo_bd[0] <= 2,
          f"{len(hechos)} mensajes, máximo visto por los workers {max(maximo_cl.values())}, máximo visto en la base {maximo_bd[0]}")

cur.execute("SELECT conversacion_id FROM mensajes_entrantes WHERE message_id='cola.7.0'"); CV7 = cur.fetchone()[0]
debe_fallar("oferta de horarios guardada en una respuesta que no es una oferta",
            "UPDATE mensajes_entrantes SET oferta_slots = ARRAY[1]::bigint[] WHERE message_id = 'cola.7.0'")
cur.execute("SELECT id FROM slots ORDER BY id LIMIT 1"); SLOT_X = cur.fetchone()[0]
cur.execute(Q("horario_ofrecido"), P(slot_id=SLOT_X, clinica_id=CLIN)); h_propio = cur.fetchall()
cur.execute(Q("horario_ofrecido"), P(slot_id=SLOT_X, clinica_id=CLIN2)); h_ajeno = cur.fetchall()
comprobar("horario ofrecido: se lee con su clínica; con otra clínica, vacío", len(h_propio) == 1 and h_ajeno == [])
cur.execute(Q("oferta_detalle"), P(slots=[SLOT_X], clinica_id=CLIN)); d_propio = cur.fetchall()
cur.execute(Q("oferta_detalle"), P(slots=[SLOT_X], clinica_id=CLIN2)); d_ajeno = cur.fetchall()
comprobar("detalle de la oferta: hora, profesional, sede, especialidad y disponibilidad con su clínica; con otra clínica, vacío",
          len(d_propio) == 1 and len(d_propio[0]) == 6 and d_ajeno == [])
cur.execute(Q("bandeja_todas"), P(clinica_id=CLIN))
comprobar("bandeja sin filtro: devuelve conversaciones de la clínica, la más reciente primero", len(cur.fetchall()) > 0)
cur.execute(Q("detalle_conversacion"), P(conversacion_id=CV7, clinica_id=CLIN)); propia = cur.fetchall()
cur.execute(Q("detalle_conversacion"), P(conversacion_id=CV7, clinica_id=CLIN2)); ajena = cur.fetchall()
comprobar("detalle de conversación: con la clínica correcta se lee; con otra clínica, vacío", len(propia) == 1 and ajena == [])
cur.execute(Q("contexto_clinica"), P(clinica_id=CLIN)); zona = cur.fetchone()[1]
cur.execute(Q("contexto_sedes"), P(clinica_id=CLIN)); n_sedes = len(cur.fetchall())
cur.execute(Q("contexto_especialidades"), P(clinica_id=CLIN2)); esp_otra = [r[1] for r in cur.fetchall()]
comprobar("contexto de la clínica: zona horaria, y solo sus propias sedes y especialidades",
          zona == "America/Bogota" and n_sedes >= 1 and esp_otra == ["dermatologia"], f"{zona}, {n_sedes} sedes, {esp_otra}")
cur.execute(Q("contexto_ultimos_turnos"), P(conversacion_id=CV7, n=2))
comprobar("contexto para el modelo: los últimos N turnos, entregados en orden cronológico",
          [r[0] for r in cur.fetchall()] == ["cola.7.1", "cola.7.2"])

# --------------------------------------------------------------------------
decir("\n6. Webhook: duplicados y límite por teléfono")
# --------------------------------------------------------------------------


def webhook(conn, tel, mid, texto="hola", enviado="2026-10-06T03:40:00Z"):
    """Transacción del webhook. Devuelve (código HTTP, motivo)."""
    k = conn.cursor()
    k.execute(Q("webhook_conversacion"), P(clinica_id=CLIN, telefono=tel))
    cv = k.fetchone()[0]
    datos = P(message_id=mid, conversacion_id=cv, texto=texto, enviado_en=enviado)
    k.execute(Q("webhook_insertar_mensaje"), datos)
    if not k.fetchone():
        k.execute(Q("webhook_es_mismo_evento"), datos)
        igual = k.fetchone()[0]
        conn.commit() if igual else conn.rollback()
        return (202, "duplicado") if igual else (409, "conflicto")
    k.execute(Q("webhook_contar_recientes"), datos)
    if k.fetchone()[0] > 20:
        conn.rollback(); return 429, "limite"
    k.execute(Q("webhook_tocar_conversacion"), datos)
    conn.commit(); return 202, "nuevo"


codigos = [webhook(w1, "+573009990000", f"lim.{i}") for i in range(22)]
comprobar("los primeros 20 mensajes del minuto se aceptan", all(x == (202, "nuevo") for x in codigos[:20]))
comprobar("el mensaje 21 y el 22 reciben 429", codigos[20][0] == 429 and codigos[21][0] == 429)
comprobar("un duplicado con el teléfono en su límite recibe 202, no 429", webhook(w1, "+573009990000", "lim.3") == (202, "duplicado"))
cur.execute("SELECT count(*) FROM mensajes_entrantes WHERE message_id LIKE 'lim.%'")
comprobar("los mensajes rechazados por límite no quedaron guardados", cur.fetchone()[0] == 20)
comprobar("mismo message_id con otro texto: 409, no se acepta como duplicado", webhook(w1, "+573009990000", "lim.3", texto="quiero cancelar todo") == (409, "conflicto"))
comprobar("mismo message_id desde otro teléfono: 409", webhook(w1, "+573009990001", "lim.3") == (409, "conflicto"))
cur.execute("SELECT texto FROM mensajes_entrantes WHERE message_id='lim.3'")
comprobar("el mensaje original no cambió", cur.fetchone()[0] == "hola")

# --------------------------------------------------------------------------
decir("\n7. Outbox")
# --------------------------------------------------------------------------
cur.execute("UPDATE trazas_pendientes SET creado_en = now() - interval '1 hour' WHERE message_id='a.1'")
k1, k2 = w1.cursor(), w2.cursor()
t1 = tomar_traza(k1)
t2 = tomar_traza(k2)
comprobar("dos relevos simultáneos toman trazas distintas", t1 and t2 and t1 != t2, f"{t1} / {t2}")
w1.rollback()                                   # el relevo 1 muere antes de confirmar
k2.execute(Q("relevo_publicada"), P(message_id=t2[0], intento=t2[1])); w2.commit()
t1b = tomar_traza(k1)
comprobar("si el relevo muere, la traza queda disponible de nuevo", t1b == t1)
for _ in range(10):
    k1.execute(Q("relevo_rechazada"), P(message_id=t1[0], intento=t1[1], error="rechazado"))
w1.commit()
t1c = tomar_traza(k1); w1.rollback()
comprobar("tras 10 rechazos pasa a requiere_revision y no bloquea a las demás", t1c is not None and t1c != t1, str(t1c))
# Relevo: ¿qué pasa en Postgres si la aplicación se queda esperando a Mongo con la transacción abierta?
rel = conectar(); kr = rel.cursor()
kr.execute(Q("relevo_limite_inactividad").replace("10s", "1s"))     # mismo mecanismo, con 1 s para no esperar 10
tomada = tomar_traza(kr)
time.sleep(2.5)                                   # la aplicación "espera a Mongo" más de lo permitido
try:
    kr.execute("SELECT 1"); cortada = False
except Exception:
    cortada = True
otra = tomar_traza(k2); w2.rollback()
comprobar("si el relevo se cuelga esperando a Mongo, Postgres corta su transacción y libera la traza",
          cortada and otra == tomada, f"cortada={cortada} tomada={tomada} disponible={otra}")

cur.execute(Q("detalle_trazas_en_outbox"), P(conversacion_id=convA))
filas = cur.fetchall()
comprobar("el detalle puede leer del outbox la traza que no llegó a Mongo, con su estado", any(f[3] == "requiere_revision" for f in filas), str([(f[0], f[1], f[3]) for f in filas]))

# --------------------------------------------------------------------------
decir("\n7b. Búsqueda vectorial (solo con pgvector instalado)")
# --------------------------------------------------------------------------
if not hay_vector:
    decir("  OMITIDA: pgvector no está instalado. 'conocimiento_buscar' queda SIN verificar.")
else:
    import math, unicodedata

    def embedding_falso(texto):
        """Embedding determinista para pruebas: bolsa de palabras en 1536 dimensiones, normalizada.
        No mide calidad semántica; sirve para probar que la consulta ordena, filtra y calcula bien."""
        v = [0.0] * 1536
        limpio = "".join(c for c in unicodedata.normalize("NFD", texto.lower()) if c.isalnum() or c == " ")
        for palabra in limpio.split():
            if len(palabra) > 3:
                v[int(hashlib.sha256(palabra.encode()).hexdigest(), 16) % 1536] += 1.0
        norma = math.sqrt(sum(x * x for x in v)) or 1.0
        return "[" + ",".join(f"{x / norma:.6f}" for x in v) + "]"

    def ingerir_real(clinica, titulo, lineas, modelo="m"):
        cur.execute(Q("ingestion_borrar_documento"), P(clinica_id=clinica, titulo=titulo))
        cur.execute(Q("ingestion_insertar_documento"), P(clinica_id=clinica, titulo=titulo, huella=titulo))
        doc = cur.fetchone()[0]
        cur.execute(Q("ingestion_insertar_lineas"), P(documento_id=doc, textos=lineas))
        cur.execute(Q("ingestion_insertar_fragmento"), fragmento(doc, clinica, 1, 2, len(lineas), modelo, embedding_falso(" ".join(lineas))))
        return doc

    def buscar(clinica, pregunta, modelo="m"):
        cur.execute(Q("conocimiento_buscar"), P(clinica_id=clinica, modelo=modelo, embedding=embedding_falso(pregunta)))
        return cur.fetchall()

    cur.execute("INSERT INTO clinicas (nombre) VALUES ('Clínica V1'),('Clínica V2') RETURNING id"); V1, V2 = [r[0] for r in cur.fetchall()]
    D_HOR = ingerir_real(V1, "Horarios", ["## Horarios", "Sede Norte: lunes a sábado, de 8:00 a. m. a 12:00 p. m.", "Sede Sur: lunes a viernes, de 7:00 a. m. a 5:00 p. m."])
    D_ECO = ingerir_real(V1, "Preparación de exámenes", ["## Ecografía abdominal", "Requiere ayuno de 8 horas antes del examen.", "Puede tomar agua hasta 2 horas antes."])
    D_CAN = ingerir_real(V1, "Cancelaciones", ["## Política de cancelación", "Las citas se cancelan con 24 horas de anticipación.", "Una cancelación tardía tiene un cobro."])
    D_AJ = ingerir_real(V2, "Preparación de exámenes", ["## Ecografía abdominal", "Requiere ayuno de 12 horas antes del examen."])

    r = buscar(V1, "¿cuántas horas de ayuno necesito para la ecografía abdominal?")
    comprobar("búsqueda vectorial: el fragmento más cercano es el que habla del tema", r and r[0][1] == D_ECO, str([(x[1], round(x[5], 3)) for x in r]))
    comprobar("búsqueda vectorial: resultados ordenados de mayor a menor similitud", [x[5] for x in r] == sorted([x[5] for x in r], reverse=True))
    comprobar("búsqueda vectorial: la similitud queda entre 0 y 1", all(0.0 <= x[5] <= 1.0 + 1e-6 for x in r))
    comprobar("búsqueda vectorial: nunca devuelve fragmentos de otra clínica", D_AJ not in [x[1] for x in r] and all(x[1] in (D_HOR, D_ECO, D_CAN) for x in r))
    r2 = buscar(V2, "ayuno ecografía abdominal")
    comprobar("búsqueda vectorial: la otra clínica solo ve su propio documento", [x[1] for x in r2] == [D_AJ])
    comprobar("búsqueda vectorial: con otro modelo de embeddings configurado no devuelve nada", buscar(V1, "ayuno ecografía", modelo="otro-modelo") == [])
    lejos = buscar(V1, "¿venden zapatos deportivos talla cuarenta?")
    comprobar("búsqueda vectorial: una pregunta ajena obtiene similitud baja (aplicar el umbral es tarea de la aplicación; aquí no se prueba)",
              all(x[5] < 0.2 for x in lejos) and r[0][5] > 0.4, f"ajena={[round(x[5], 3) for x in lejos]} pertinente={round(r[0][5], 3)}")
    cur.execute(Q("conocimiento_buscar_con_texto"), P(clinica_id=V1, modelo="m", embedding=embedding_falso("¿cuántas horas de ayuno necesito para la ecografía abdominal?")))
    filas = cur.fetchall()
    primero = [f for f in filas if f[0] == filas[0][0]]
    comprobar("búsqueda con texto: el mejor fragmento llega con sus líneas literales, en orden, y con el título y la huella de su documento",
              [f[7] for f in primero] == ["## Ecografía abdominal", "Requiere ayuno de 8 horas antes del examen.", "Puede tomar agua hasta 2 horas antes."]
              and primero[0][1] == D_ECO and primero[0][4] == "Preparación de exámenes" and primero[0][5] == "Preparación de exámenes")
    comprobar("búsqueda con texto: mismos fragmentos y mismo orden que la búsqueda sola, y nada de otra clínica",
              list(dict.fromkeys(f[0] for f in filas)) == [x[0] for x in r] and all(f[1] in (D_HOR, D_ECO, D_CAN) for f in filas))

    # Volumen: 50 clínicas con 200 fragmentos cada una, búsqueda exacta filtrada por clínica
    cur.execute("INSERT INTO clinicas (nombre) SELECT 'Volumen ' || g FROM generate_series(1,50) g RETURNING id"); CLINV = [r[0] for r in cur.fetchall()]
    cur.execute("""INSERT INTO documentos (clinica_id, titulo, huella) SELECT c, 'Doc', 'h' FROM unnest(%s::bigint[]) c RETURNING id, clinica_id""", (CLINV,))
    docs_v = cur.fetchall()
    cur.execute("""INSERT INTO documento_lineas (documento_id, numero, texto)
                   SELECT d, n, 'línea ' || n FROM unnest(%s::bigint[]) d, generate_series(1, 401) n""", ([d[0] for d in docs_v],))
    cur.execute("""INSERT INTO fragmentos_conocimiento (documento_id, clinica_id, linea_encabezado, linea_inicial, linea_final, embedding, modelo_embedding)
                   SELECT d.id, d.clinica_id, 1, 2 * g, 2 * g + 1,
                          (SELECT array_agg(random())::vector FROM generate_series(1, 1536) WHERE g = g AND d.id = d.id), 'm'
                   FROM documentos d, generate_series(1, 200) g WHERE d.id = ANY(%s::bigint[])""", ([d[0] for d in docs_v],))
    cur.execute("ANALYZE fragmentos_conocimiento")
    cur.execute("SELECT count(*) FROM fragmentos_conocimiento"); decir(f"  Fragmentos para la medición: {cur.fetchone()[0]} (50 clínicas x 200)")

# --------------------------------------------------------------------------
decir("\n8. Planes de ejecución con volumen")
# --------------------------------------------------------------------------
cur.execute("""INSERT INTO conversaciones (clinica_id, telefono, estado, motivo_escalamiento, ultima_actividad)
               SELECT %s, '+5790' || lpad(g::text, 8, '0'),
                      (ARRAY['en_curso','resuelta_por_ia','resuelta_por_ia','cita_agendada','escalada'])[1 + g %% 5],
                      CASE WHEN g %% 5 = 4 THEN 'sin información' END,
                      now() - (g %% 100000) * interval '1 minute'
               FROM generate_series(1, 200000) g""", (CLIN,))
# Estadísticas de la tabla referenciada antes de cargar un millón de FK.
# Evita conservar un plan de comprobación elegido cuando había pocas conversaciones.
# El ANALYZE general y las mediciones de abajo siguen sin cambios.
cur.execute("ANALYZE conversaciones")
cur.execute("""INSERT INTO mensajes_entrantes (message_id, conversacion_id, texto, enviado_en, recibido_en, estado,
                                              intento_actual, intento_valido, respuesta_tipo, respuesta_texto)
               SELECT 'vol.' || c.id || '.' || n, c.id, 'hola', now() - n * interval '1 hour', now() - n * interval '1 hour',
                      'procesado', 1, 1, 'sin_informacion', 'x'
               FROM conversaciones c, generate_series(1,5) n WHERE c.telefono LIKE '+5790%%'""")
cur.execute("""INSERT INTO mensajes_entrantes (message_id, conversacion_id, texto, enviado_en)
               SELECT 'pend.' || id, id, 'hola', now() FROM conversaciones
               WHERE telefono LIKE '+5790%%' AND mod(id, 700) = 0""")
cur.execute("""UPDATE conversaciones SET procesando_hasta = now() + interval '2 minutes'
               WHERE telefono LIKE '+5790%%' AND mod(id, 1400) = 0""")
# Citas históricas, para que la búsqueda por mensaje se mida con una tabla grande
cur.execute("""INSERT INTO citas (clinica_id, slot_id, conversacion_id, source_message_id, estado)
               SELECT %s, (SELECT min(id) FROM slots), m.conversacion_id, m.message_id, 'cancelada'
               FROM mensajes_entrantes m WHERE m.message_id LIKE 'vol.%%.1' LIMIT 100000""", (CLIN,))
cur.execute("ANALYZE")
cur.execute("SELECT (SELECT count(*) FROM conversaciones), (SELECT count(*) FROM mensajes_entrantes), (SELECT count(*) FROM mensajes_entrantes WHERE estado IN ('pendiente','procesando'))")
decir("  Volumen: %d conversaciones, %d mensajes, %d sin terminar" % cur.fetchone())


def plan(nombre, sql, params=None, limite_ms=20.0, prohibido=("Seq Scan on mensajes_entrantes", "Seq Scan on conversaciones")):
    """Plan y tiempo de una sentencia. El tiempo es la MEDIANA de 5 ejecuciones:
    una sola medición puede salir alta por ruido de la máquina (otra carga, caché
    fría) sin que el plan haya cambiado. El plan guardado es el de la última.
    Es una prueba de regresión, no una garantía de latencia: una mediana puede
    pasar aunque haya ejecuciones lentas, por eso se informa también el rango.
    No equivale a un percentil 95 ni a un compromiso de servicio."""
    params = P(**(params or {}))
    k = conectar(); kk = k.cursor()
    tiempos = []
    for _ in range(5):
        kk.execute("EXPLAIN (ANALYZE, BUFFERS) " + sql, params)
        texto = "\n".join(r[0] for r in kk.fetchall()); k.rollback()
        tiempos.append(float(texto.split("Execution Time: ")[1].split(" ms")[0]))
    k.close()
    ms = sorted(tiempos)[2]
    malos = [p for p in prohibido if p in texto]
    comprobar(f"{nombre}: {ms:.2f} ms (mediana de 5; rango {min(tiempos):.2f} a {max(tiempos):.2f})", ms < limite_ms and not malos, ", ".join(malos))
    return texto


planes = {}
planes["reclamo"] = plan("reclamo del worker", RECLAMO)
cur.execute("SELECT id FROM conversaciones WHERE telefono LIKE '+5790%%' ORDER BY id LIMIT 1 OFFSET 5000"); CV = cur.fetchone()[0]
planes["limite"] = plan("límite por teléfono", Q("webhook_contar_recientes"), dict(conversacion_id=CV))
planes["bandeja"] = plan("bandeja por estado", Q("bandeja"), dict(clinica_id=CLIN, estado="escalada"))
planes["historial"] = plan("contexto: últimos 10 turnos", Q("contexto_ultimos_turnos"), dict(conversacion_id=CV, n=10))
cur.execute("SELECT id FROM especialidades WHERE clinica_id=%s AND nombre='dermatologia'", (CLIN,)); ESP_ID = cur.fetchone()[0]
cur.execute("SELECT date_trunc('day', now()) + interval '3 days', date_trunc('day', now()) + interval '4 days'"); DESDE, HASTA = cur.fetchone()
planes["disponibilidad"] = plan("disponibilidad por especialidad, sede y fecha", Q("disponibilidad"),
                                dict(clinica_id=CLIN, especialidad_id=ESP_ID, sede_id=SEDES[0], desde=DESDE, hasta=HASTA), prohibido=())
if hay_vector:
    planes["busqueda_vectorial"] = plan("búsqueda vectorial exacta: 200 fragmentos de una clínica entre 10.000", Q("conocimiento_buscar"),
                                        dict(clinica_id=CLINV[25], modelo="m", embedding=embedding_falso("ayuno ecografía abdominal")),
                                        limite_ms=50.0, prohibido=("Seq Scan on fragmentos_conocimiento",))
planes["outbox"] = plan("siguiente traza del outbox", Q("relevo_tomar"), prohibido=())
planes["cita_propia"] = plan("¿existe cita de este mensaje?", Q("cita_de_mensaje"), dict(message_id="b.1"), prohibido=("Seq Scan on citas",))

# Atraso grande: 20.000 mensajes pendientes (equivale a un día entero sin procesar)
cur.execute("""INSERT INTO mensajes_entrantes (message_id, conversacion_id, texto, enviado_en)
               SELECT 'atraso.' || id, id, 'hola', now() FROM conversaciones
               WHERE telefono LIKE '+5790%' AND mod(id, 10) = 3""")
cur.execute("ANALYZE mensajes_entrantes")
planes["reclamo_con_atraso"] = plan("reclamo con 20.000 atrasados, todos listos", RECLAMO, limite_ms=5.0)

# Atraso con muchos mensajes esperando reintento. Los más antiguos quedan en espera:
# es el peor caso para un índice ordenado solo por secuencia.
RECLAMO_POR_SECUENCIA = RECLAMO.replace("ORDER BY m.proximo_intento_en, m.secuencia", "ORDER BY m.secuencia")
cur.execute("SELECT count(*) FROM mensajes_entrantes WHERE estado IN ('pendiente','procesando')"); TOTAL = cur.fetchone()[0]
for listos in (50, 10):
    cur.execute("UPDATE mensajes_entrantes SET proximo_intento_en = now() - interval '1 minute' WHERE estado IN ('pendiente','procesando')")
    cur.execute("""UPDATE mensajes_entrantes SET proximo_intento_en = now() + interval '1 hour'
                   WHERE message_id IN (SELECT message_id FROM mensajes_entrantes WHERE estado IN ('pendiente','procesando')
                                        ORDER BY secuencia LIMIT %s)""", (TOTAL * (100 - listos) // 100,))
    # Tras una actualización masiva se limpia como lo haría autovacuum: se mide la consulta, no las filas muertas
    cur.execute("VACUUM (ANALYZE) mensajes_entrantes")
    planes[f"reclamo_{listos}_listos"] = plan(f"reclamo con {100 - listos}% de la cola esperando reintento", RECLAMO, limite_ms=5.0)
    # Referencia: el diseño descartado (índice y orden solo por secuencia)
    cur.execute("DROP INDEX mensajes_cola_listos")
    cur.execute("CREATE INDEX ref_por_secuencia ON mensajes_entrantes (secuencia) WHERE estado IN ('pendiente','procesando')")
    cur.execute("VACUUM (ANALYZE) mensajes_entrantes")
    planes[f"referencia_secuencia_{listos}_listos"] = plan(
        f"referencia: mismo escenario con índice solo por secuencia (descartado)", RECLAMO_POR_SECUENCIA, limite_ms=100000.0, prohibido=())
    cur.execute("DROP INDEX ref_por_secuencia")
    cur.execute("CREATE INDEX mensajes_cola_listos ON mensajes_entrantes (proximo_intento_en, secuencia) WHERE estado IN ('pendiente','procesando')")

# Peor caso del diseño elegido: mensajes listos pero bloqueados, porque el más
# antiguo de su conversación espera reintento. 2.000 conversaciones con 5 cada una.
cur.execute("UPDATE mensajes_entrantes SET proximo_intento_en = now() + interval '1 hour' WHERE estado IN ('pendiente','procesando')")
cur.execute("""INSERT INTO mensajes_entrantes (message_id, conversacion_id, texto, enviado_en, proximo_intento_en)
               SELECT 'bloq.' || c.id || '.' || n, c.id, 'hola', now(), now() - interval '10 minutes' + n * interval '1 second'
               FROM (SELECT id FROM conversaciones WHERE telefono LIKE '+5790%' AND mod(id, 10) = 3 ORDER BY id LIMIT 2000) c,
                    generate_series(1,5) n""")
cur.execute("VACUUM (ANALYZE) mensajes_entrantes")
planes["reclamo_listos_bloqueados"] = plan("reclamo con 10.000 mensajes listos pero bloqueados por el más antiguo de su conversación", RECLAMO, limite_ms=100000.0, prohibido=())

open(os.path.join(AQUI, "planes.txt"), "w").write("\n\n".join(f"== {n} ==\n{t}" for n, t in planes.items()))

sin_ejecutar = sorted(set(CONSULTAS) - USADAS)
decir(f"\nSentencias de consultas.sql ejecutadas: {len(USADAS & set(DEL_ASISTENTE))} de {len(DEL_ASISTENTE)}")
decir(f"Sentencias de ingestion.sql ejecutadas: {len(USADAS & set(DE_INGESTION))} de {len(DE_INGESTION)}")
decir("Sin ejecutar: " + (", ".join(sin_ejecutar) if sin_ejecutar else "ninguna"))

fallas = [n for n, ok in resultados if not ok]
decir(f"\nResultado: {len(resultados) - len(fallas)} de {len(resultados)} comprobaciones correctas")
for n in fallas:
    decir("  FALLA: " + n)
open(os.path.join(AQUI, "resultado.txt"), "w", encoding="utf-8").write("\n".join(_salida) + "\n")
sys.exit(1 if fallas else 0)
