"""Escalabilidad de la búsqueda vectorial por tamaño de clínica.

Uso:  python3 benchmark_vectorial.py [--dsn "..."]
Requiere pgvector y haber ejecutado antes verificar.py (usa su base "verificacion").

Pregunta que responde: ¿hasta cuántos fragmentos EN UNA SOLA CLÍNICA sigue siendo
suficiente la búsqueda exacta? Lo que importa no es el total de fragmentos del
sistema sino el de la clínica más grande, porque toda búsqueda filtra por clínica.

Mide la sentencia real "conocimiento_buscar" de consultas.sql, 40 veces por
tamaño, y reporta la mediana (p50) y el percentil 95. Al final compara con un
índice HNSW en el tamaño mayor, incluida la exactitud de sus resultados.
Los vectores son aleatorios: sirve para medir tiempo, no calidad semántica.
"""
import argparse, os, random, re, statistics, time
from datetime import datetime, timezone
import psycopg2

AQUI = os.path.dirname(os.path.abspath(__file__))
a = argparse.ArgumentParser()
a.add_argument("--dsn", default="host=/tmp port=5544 user=postgres")
ARGS = a.parse_args()

sql = open(os.path.join(AQUI, "..", "sql", "consultas.sql"), encoding="utf-8").read()
bloque = sql.split("-- name: conocimiento_buscar")[1].split("-- name:")[0]
BUSCAR = "\n".join(l for l in bloque.splitlines() if not l.lstrip().startswith("--")).strip().rstrip(";")
BUSCAR = re.sub(r"(?<![:\w]):([a-z_]+)", r"%(\1)s", BUSCAR.replace("%", "%%"))

c = psycopg2.connect(f"{ARGS.dsn} dbname=verificacion"); c.autocommit = True
k = c.cursor()
salida = []


def decir(t=""):
    print(t, flush=True); salida.append(t)
    open(os.path.join(AQUI, "benchmark_vectorial.txt"), "w", encoding="utf-8").write("\n".join(salida) + "\n")


def vector_aleatorio():
    return "[" + ",".join(f"{random.random():.5f}" for _ in range(1536)) + "]"


def clinica_con(n):
    """Crea una clínica con n fragmentos de vectores aleatorios."""
    k.execute("INSERT INTO clinicas (nombre) VALUES (%s) RETURNING id", (f"Tamaño {n}",)); clin = k.fetchone()[0]
    k.execute("INSERT INTO documentos (clinica_id, titulo, huella) VALUES (%s,'Doc','h') RETURNING id", (clin,)); doc = k.fetchone()[0]
    k.execute("INSERT INTO documento_lineas (documento_id, numero, texto) SELECT %s, g, 'línea ' || g FROM generate_series(1, %s) g", (doc, 2 * n + 1))
    k.execute("""INSERT INTO fragmentos_conocimiento (documento_id, clinica_id, linea_encabezado, linea_inicial, linea_final, embedding, modelo_embedding)
                 SELECT %s, %s, 1, 2 * g, 2 * g + 1,
                        (SELECT array_agg(random())::vector FROM generate_series(1, 1536) WHERE g = g), 'm'
                 FROM generate_series(1, %s) g""", (doc, clin, n))
    return clin


def medir(clin, repeticiones=40):
    tiempos, respuestas = [], []
    for _ in range(repeticiones):
        p = dict(clinica_id=clin, modelo="m", embedding=vector_aleatorio(), ahora=datetime.now(timezone.utc))
        t = time.perf_counter(); k.execute(BUSCAR, p); filas = k.fetchall()
        tiempos.append((time.perf_counter() - t) * 1000); respuestas.append((p["embedding"], [f[0] for f in filas]))
    tiempos.sort()
    return statistics.median(tiempos), tiempos[int(len(tiempos) * 0.95) - 1], respuestas


decir("Búsqueda exacta, filtrada por clínica y modelo (sentencia real de consultas.sql)")
decir(f"{'fragmentos en la clínica':>26} | {'p50 ms':>8} | {'p95 ms':>8}")
clinicas = {}
for n in (200, 1000, 5000, 10000, 25000):
    clinicas[n] = clinica_con(n)
    k.execute("ANALYZE fragmentos_conocimiento")
    p50, p95, _ = medir(clinicas[n])
    decir(f"{n:>26} | {p50:>8.1f} | {p95:>8.1f}")

decir()
decir("Referencia: índice HNSW (coseno) solo sobre la clínica de 25.000 fragmentos")
decir("  Alcance de esta referencia:")
decir("  - Es un índice parcial de una clínica. Para que el planificador lo use, la consulta nombra la")
decir("    clínica como constante: NO es la sentencia parametrizada que ejecuta la aplicación.")
decir("  - Muestra que un índice aproximado es mucho más rápido y que NO devuelve lo mismo que la búsqueda exacta.")
decir("  - Los vectores son aleatorios, el peor caso para un índice aproximado: la coincidencia medida aquí")
decir("    no es una estimación de lo que se obtendría con embeddings reales.")
grande = clinicas[25000]
_, _, exactas = medir(grande, 20)
t = time.perf_counter()
k.execute("SET maintenance_work_mem = '1GB'")
k.execute(f"CREATE INDEX ref_hnsw ON fragmentos_conocimiento USING hnsw (embedding vector_cosine_ops) WHERE clinica_id = {int(grande)}")
decir(f"  construir el índice de esa clínica: {time.perf_counter() - t:.0f} s")
k.execute("ANALYZE fragmentos_conocimiento")
tiempos, aciertos, devueltos = [], 0, 0
for emb, ids_exactos in exactas:
    # El índice parcial solo aplica si la consulta nombra la clínica como constante
    consulta = BUSCAR.replace("%(clinica_id)s", str(int(grande)))
    p = dict(modelo="m", embedding=emb)
    t = time.perf_counter(); k.execute(consulta, p); ids = [f[0] for f in k.fetchall()]
    tiempos.append((time.perf_counter() - t) * 1000)
    aciertos += len(set(ids) & set(ids_exactos)); devueltos += len(ids)
tiempos.sort()
k.execute("EXPLAIN " + consulta, dict(modelo="m", embedding=exactas[0][0]))
usa_hnsw = any("ref_hnsw" in f[0] for f in k.fetchall())
decir(f"  el planificador {'usa' if usa_hnsw else 'NO usa'} el índice HNSW para esta consulta")
decir(f"  p50 {statistics.median(tiempos):.1f} ms | p95 {tiempos[int(len(tiempos) * 0.95) - 1]:.1f} ms")
decir(f"  resultados devueltos: {devueltos} de {4 * len(exactas)} pedidos; coinciden con la búsqueda exacta: {aciertos} de {4 * len(exactas)}")
k.execute("DROP INDEX ref_hnsw")

