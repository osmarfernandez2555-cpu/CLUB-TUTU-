# Club Tutu+ · Landing

La comunidad tutusera más grande de Argentina. Tres botones:

1. **Club de referidos** → abre https://tutu-referidos.up.railway.app/referidos
2. **Tutu Express** → la persona pone nombre, WhatsApp y CUIT. La landing manda el CUIT al robot de créditos (consulta-bancor), muestra "Evaluando tu situación crediticia, puede tardar hasta 2 minutos" y después:
   - **Aprobado** → muestra con qué banco y pregunta qué vehículo le interesa para que un asesor lo contacte
   - **Sin ofertas** (todos los bancos dijeron DENEGADO) → "No hay ofertas en este momento, podés intentarlo con otro CUIT de alguien de confianza"
   - **Revisar** (algún banco dio error/REVISAR o pasaron 2 min y medio) → "Lo revisamos a mano" y también le pide el vehículo
3. **Mystery Box** → cerrada con cuenta regresiva de 10 días (hasta el 4/12/2026 a las 20 h). Botón "Me interesa" que cuenta cuánta gente la quiere y opción de dejar el WhatsApp para avisarles. Cuando llega a cero, el botón se convierte en link a https://osmarfernandez2555-cpu.github.io/mistery-box-tutu/

## Archivos

- `index.html` → la página
- `server.js` → servidor (habla con el robot sin mostrar la clave en la página, guarda leads y cuenta interesados)
- `fonts/` → letras de la marca (Roboto Condensed + DM Sans)
- `package.json`

## Subirlo a Railway (paso a paso)

1. Creá un repo nuevo en GitHub, por ejemplo `club-tutu`, y subí todos estos archivos (incluida la carpeta `fonts`).
2. En Railway: **New Project → Deploy from GitHub repo → club-tutu**.
3. En el mismo proyecto: **New → Database → PostgreSQL** (base propia, como hiciste con tutu-referidos).
4. En el servicio `club-tutu` → **Variables**, cargá:
   - `ROBOT_URL` = la dirección de tu app consulta-bancor en Railway (ej: `https://consulta-bancor-production.up.railway.app`, sin barra al final)
   - `ROBOT_CLAVE` = **la misma** `ROBOT_CLAVE` que tiene consulta-bancor en sus variables
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (variable de referencia a la base)
   - `ADMIN_CLAVE` = una clave que inventes para ver el panel
   - Opcionales:
     - `EXPRESS_BANCOS` = qué bancos consultar, ej `galicia,santander,decreditos` (vacío = los que el robot usa por defecto)
     - `LEADS_WEBHOOK` = URL que recibe cada lead (Kommo, Make, Ruthina, tu CRM). Manda eventos `express_nuevo`, `express_resultado`, `express_vehiculo` y `mystery_avisame`
     - `MYSTERY_APERTURA` = fecha de apertura, ej `2026-12-04T20:00:00-03:00`
     - `MYSTERY_URL`, `REFERIDOS_URL` = si cambian los links
5. **Settings → Networking → Generate Domain**. Esa es la dirección para compartir.
6. Probá `https://TU-DOMINIO/salud`: tiene que decir `"robot":true,"db":true`.

## Dónde ver los resultados

`https://TU-DOMINIO/admin?clave=TU_ADMIN_CLAVE`

- Cantidad de interesados en la Mystery Box y los WhatsApp que dejaron
- Todos los que usaron Tutu Express: nombre, WhatsApp (con link directo), CUIT, resultado, bancos y vehículo que les interesa

## Si algo falla

- **Siempre sale "Lo revisamos a mano" al instante** → falta `ROBOT_URL` o `ROBOT_CLAVE`, o la clave no coincide con la de consulta-bancor. Mirá los logs del servicio: dice `[Robot] respuesta: 401` si la clave está mal.
- **Se queda evaluando y a los 2 min y medio pasa a "revisar"** → la PC robot de la oficina no está conectada o las extensiones no tienen sesión. Fijate en consulta-bancor `/prueba-robot`.
- **"Hiciste varias consultas seguidas"** → límite antiabuso: 5 consultas por hora por conexión y 3 por día por CUIT.
- **No aparecen las fotos de los autos** → se cargan de tutuautomotores.com; si cambian las fotos en la web, actualizá la lista `FOTOS` en `index.html`.
- **Error de base de datos en los logs** → revisá que `DATABASE_URL` apunte a la Postgres del mismo proyecto.

## Probarlo sin robot

Abrí la página con `?demo` al final (ej: `https://TU-DOMINIO/?demo`): los resultados son simulados. CUIT terminado en número par = aprobado, impar = sin ofertas.
