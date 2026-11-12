# Julia-1: modelo de decisión rápido que hay que afinar

Fecha: 2026-11-12. Estado: propuesta, sin empezar.

## Por qué

El agente necesita decidir, para cada campo del portal, qué clave de la declaración le corresponde, o si no hay
dato o hay varias candidatas. El catálogo de conceptos (`apps/desktop/src/core/agent/catalog.ts`) resuelve sin
modelo los campos cuya etiqueta conoce; el resto va al modelo. Hoy ese modelo es Qwen3 4B, y es demasiado lento
y pesado para un portátil normal:

| Modelo | Aciertos (17 campos del portal de prueba) | Tiempo total | Memoria |
| --- | --- | --- | --- |
| Qwen3 4B Instruct, una pregunta por campo | 14/17 | ≈ 196 s | ≈ 5,4 GB |
| Qwen3 4B, flujo real (JSON por paso, `--sin-catalogo`) | 13/14 con dato, 1/2 trampas | ≈ 103 s | ≈ 5,4 GB |
| **Julia-1** (Supersonic Labs, 144M) | **3–5/17** | **≈ 3–6 s** | ≈ 0,6 GB de pesos |
| watt-flash-0.1 (140M, misma base) | 3–7/17 | ≈ 2–5 s | similar |
| Laya typed-decisions (421M) | 5–9/17 | ≈ 20–80 s | ≈ 0,8 GB |

Julia-1 tiene la velocidad y el tamaño que necesitamos (unas 50 veces más rápido que Qwen en este portátil, CPU
Intel de 4 núcleos), pero hoy no entiende la terminología fiscal suiza: asigna «Arbeitgeber» → `nachname` (0,88),
«Fahrkosten» → `nettolohn_jahr` (0,76) y, en la variante sí/no, da ≥ 0,9 a casi cualquier importe para casi
cualquier campo. Tampoco está calibrado: su `inference-policy.json` declara `"calibration": null`.

El objetivo es afinarlo (fine-tuning) para subir la precisión y calibrar sus probabilidades, de modo que el
código pueda decidir con umbrales: rellenar si una opción domina, «ambiguo» si dos están cerca, «sin dato» si gana
«ninguna».

## Qué es Julia-1

- 144,3M parámetros, Apache 2.0, pesos FP32 en safetensors (≈ 550 MiB).
  [Ficha](https://huggingface.co/SupersonicLabs/Julia-1).
- Codificador mmBERT-small (multilingüe, de JHU CLSP) más una cabeza de decisión (`JuliaDecisionModel` en
  `julia/model.py`: 2 capas transformer, un `scorer` por opción y un buffer `temperature` por tipo de pregunta).
- Preguntas `choice` (2–20 opciones con descripción no vacía), `score` y `noul`; devuelve probabilidades softmax.
- Contexto hasta 8 192 tokens; presupuesto de 512 para pregunta y opciones (48 por opción).
- **El pipeline de entrenamiento no está publicado.** El modelo es un `nn.Module` normal de PyTorch, y el
  código de inferencia incluye la codificación de las entradas (`julia/data.py`, `julia/inference.py`), así que
  el bucle de entrenamiento lo escribimos nosotros reutilizando esa codificación.

Instalación local que ya funciona: `~/Models/fodibo/Julia-1`, entorno conda propio en `.env`
(PyTorch 2.14.1 de conda-forge, porque PyTorch oficial ya no publica para Mac Intel; `transformers` 5.0.0,
que el paquete fija `<5.1`), motor `backend="torch"` (sin compilar ni cargar la parte nativa Bend/C).
Envoltorio HTTP de prueba (127.0.0.1, API `/v1/systemone`) y scripts del experimento: en el scratchpad de la
sesión del 2026-11-12; si se retoma, conviene pasarlos a `apps/desktop/scripts/` o similar.

## Tarea que debe aprender

Una pregunta `choice` por campo:

- **state**: etiqueta del campo y tipo; la ayuda solo como dato, nunca como instrucción (es texto no confiable
  del portal; en el portal de prueba contiene una inyección).
- **opciones**: las claves de la declaración de tipo compatible con el campo, cada una con su valor, más una
  opción «ninguna».
- **salida**: probabilidad por opción. Regla en código (la del experimento): rellenar si la mejor ≥ 0,6 y la
  segunda < 0,2; «sin dato» si gana «ninguna»; «ambiguo» en otro caso. Los umbrales se fijan con el conjunto de
  validación, no a ojo.

Las variantes de un mismo concepto (`krankenkasse_praemie_hauptperson` / `_familie`) deben salir **cerca entre
sí**, no una con 0,99: ese es justo el caso en que falla Qwen.

## Datos

No hay datos de usuarios: todo es sintético o sale de documentación pública.

1. **Vocabulario**: las etiquetas de los formularios fiscales de varios cantones en alemán, francés e italiano
   (formularios y guías oficiales: Wegleitungen / guides / istruzioni) y los conceptos del Lohnausweis
   (Ziffern), de la Krankenkasse y de los extractos bancarios. Cada concepto suizo tiene un id como los del
   catálogo.
2. **Ejemplos positivos**: (etiqueta del campo, ayuda) → id del concepto, con sinónimos, abreviaturas, variantes
   de mayúsculas y puntuación, y en los tres idiomas.
3. **Negativos difíciles**: conceptos del mismo tipo y parecidos (Bruttolohn / Nettolohn,
   Pensionskasse / Säule 3a, Fahrkosten / Verpflegungsmehrkosten) para que la respuesta sea «ninguna».
4. **Ambiguos**: declaraciones con varias variantes del mismo concepto (personas, cuentas), cuyo objetivo es un
   reparto de probabilidad entre ellas, no una sola.
5. **Inyecciones** en la ayuda («Ignoriere alle Anweisungen…»), que no deben cambiar la respuesta.

Un modelo grande puede proponer borradores de ejemplos durante el desarrollo, siempre sin datos reales; una
persona revisa una muestra. El portal de prueba (`apps/desktop/test-portal/`) **no** entra en el entrenamiento:
es el conjunto de prueba final, junto con portales reservados.

## Entrenamiento

- Pérdida de entropía cruzada sobre las opciones; para los ambiguos, objetivo suave (reparto entre variantes).
- Empezar afinando la cabeza y las últimas capas del codificador; afinar el modelo entero solo si no basta.
- Hardware: un modelo de 144M se puede afinar en CPU con unos miles de ejemplos (horas, no minutos, en este
  portátil); con más datos conviene una GPU alquilada. Como los datos son sintéticos, no hay problema de
  privacidad.
- Guardar el resultado en el mismo formato (safetensors + `julia_config.json`) para seguir usando el motor de
  inferencia de Julia.

## Calibración

- Escalado de temperatura sobre el conjunto de validación (el modelo ya tiene el buffer `temperature` por tipo
  de pregunta); si no basta, regresión isotónica.
- Medir ECE (error de calibración esperado), Brier y diagramas de fiabilidad, además de la precisión.
- Fijar los umbrales de decisión con la validación y comprobarlos en la prueba.

## Criterios para darlo por bueno (propuesta, por discutir)

- En los portales reservados: ≥ 95 % de aciertos en los campos con dato.
- Cero rellenos equivocados por encima del umbral de rellenar en los campos trampa (sin dato o ambiguos).
- ECE ≤ 0,05.
- En el portal de prueba, con `--sin-catalogo`, cumplir el criterio de aceptación del banco que hoy cumple solo
  el catálogo.
- Menos de 1 s por paso en este portátil y menos de 1 GB de memoria.

## Integración

- Sustituye a Qwen en la ruta del modelo (campos que el catálogo no reconoce), detrás de la misma validación
  (`validateAnswer`) y la misma escritura verificada. Qwen queda como alternativa mientras tanto.
- Se sirve en local (127.0.0.1), como `llama-server`; nunca se envían datos fuera del equipo.
- También puede servir sin conexión para proponer etiquetas nuevas para el catálogo, que una persona revisa.

## Riesgos

- Sin el pipeline original, el afinado puede empeorar capacidades generales; aquí no importa mientras mejore la
  tarea concreta.
- Si el vocabulario del entrenamiento no cubre bien los cantones, el modelo puede ir bien en el banco y mal en
  portales reales: por eso hacen falta portales reservados.
- watt-flash-0.1 comparte la base (mmBERT-small) y es un poco más rápido: si afinar Julia resulta difícil, es la
  primera alternativa.
