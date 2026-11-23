# `memoria`, la CLI de cli-memoria

cli-memoria (antes my-memory) es una memoria compartida en git con su servidor y su CLI `memoria`.

`memoria` expone las notas Markdown en git como comandos de terminal pensados para agentes: salida compacta (una línea por resultado, con el total y cómo seguir), `--json` para filtrar con `jq`, `--simular` en todo lo que escribe y códigos de salida estables. Sin dependencias de npm: Node 22 o más y unos `.mjs`.

```sh
memoria buscar badulaque --carpeta projects --limite 5
memoria buscar pendiente --en badulaque      # dentro de una nota: sus líneas, con número y sección
memoria leer badulaque --seccion pendiente
memoria editar badulaque --razon "Pendiente al día" --viejo "- [ ] X" --nuevo "- [x] X"
memoria lista projects
memoria recientes 10
memoria --help        # todo lo demás
```

## Estructura

```text
cli/
├─ memoria.mjs       el programa: comandos, ayuda, lectura local, copia de trabajo y publicar
├─ lib/
│  ├─ nativa.mjs     opciones, errores y códigos de salida, alias en inglés, llamadas a la pasarela, --json, --simular
│  ├─ paginas.mjs    salida por páginas: ventanas de texto (~150 líneas u 8.000 caracteres) y listados con total
│  └─ pasarela.mjs   el cliente MCP de la pasarela (Streamable HTTP, JSON o SSE, con formularios)
├─ probar.sh         prueba de punta a punta contra un servidor real, con notas y agentes de juguete
└─ README.md         esto
nix/memoria.nix      el paquete `memoria` del flake
```

## Cómo lee y cómo escribe

- **Leer** (`buscar`, `leer`, `lista`, `recientes`): con `MEMORIA_DIR`, directamente en una copia del repositorio de
  notas (basta de solo lectura), con `rg` y `git`, sin pasar por MCP. Sin `MEMORIA_DIR`, las mismas lecturas por la
  pasarela (`search`, `read`, `list` y `recent` de my-memory).
  - `buscar` da una línea por resultado (`ruta:línea · sección · fragmento`) y, bajo el primer resultado de cada nota,
    `↳ (cambiada el AAAA-MM-DD) su description`. La fecha es la del último commit que tocó la nota, de una sola pasada
    de `git log` por todo el historial (unos 40 ms con 2.200 commits; lo mismo que hace el servidor al indexar). Sin
    `MEMORIA_DIR`, la que dé el servidor: `read` la da (`updated_at`); `search`, hoy no, y entonces no sale.
  - `buscar <texto> --en <nota>`: las líneas de esa nota que coinciden, con su número y su sección, y el total: se mira
    dentro de una nota sin leerla entera, y luego se lee lo que haga falta con `leer --lineas A-B` o `--seccion S`.
  - Las notas en bruto están en `MEMORIA_DIR`, para `rg -n` cuando haga falta algo que `buscar` no da.
- **Escribir** siempre lo hace el servidor (firma con la credencial del agente y aplica las reglas de `memory.toml`):
  - una nota cada vez, con esta misma CLI y por la pasarela (también sin `MEMORIA_DIR`): `crear`, `editar`, `escribir`,
    `mover`, `borrar --si` (sin `--si` no borra), `adjuntar` y `revertir`;
  - cambios de varias notas a la vez (hace falta `MEMORIA_DIR`): `memoria copia` hace un `git clone` de trabajo, se
    edita y se commitea con git, y `memoria publicar` lleva esos commits al servidor, con el hash de cada nota para no
    pisar cambios ajenos. Si el servidor tiene la herramienta `publish` (la busca en la lista de herramientas de la
    pasarela), va todo en un solo envío: un commit del servidor por cada commit de la copia, con su asunto como razón, y
    si algo falla no se guarda nada. Si no la tiene, nota a nota (`create`, `write`, `move`, `delete`), como antes: si una
    falla, lo anterior ya quedó publicado. `memoria estado` y `memoria actualizar` completan el ciclo.
- **El resto** del servidor, por la pasarela: `historial`, `enlaces`, `revisar` (lint).

## Configuración

| Variable | Para qué | Si falta |
|---|---|---|
| `MEMORIA_DIR` | La carpeta del repositorio de notas para leer en local (y para la copia de trabajo) | Todo va por la pasarela |
| `MEMORIA_COPIA` | Dónde vive la copia de trabajo de `memoria copia` | `~/memoria` |
| `BADULAQUE_URL` | La dirección MCP de la pasarela | Obligatoria para escribir o leer sin `MEMORIA_DIR` (falla con código 2) |
| `BADULAQUE_CLAVE` | La clave del agente en la pasarela (`Authorization: Bearer`) | Lo que necesite la pasarela falla con código 2 |

`rg` y `git` tienen que estar en el `PATH` para leer en local y para la copia de trabajo (el paquete de Nix los añade
al final del `PATH`).

### La pasarela

La CLI no habla con `my-memory` directamente: habla MCP con una **pasarela**, un punto MCP por HTTP que la autentica
con una clave por agente y que tiene una herramienta `buscador_usar` con dos argumentos:

- `nombre`: `memoria_<herramienta>`, donde `<herramienta>` es una de my-memory (`search`, `read`, `list`, `recent`,
  `create`, `edit`, `write`, `move`, `delete`, `publish`, `revert`, `attach`, `history`, `links`, `lint`);
- `argumentos`: los de esa herramienta, tal cual.

Y, para saber si el servidor tiene `publish`, una herramienta `buscador_buscar` con `consulta` (y `limite`) que
devuelva `{ encontradas: [{ nombre }] }` con la de nombre exacto primero, como el buscador del Badulaque. Una pasarela
sin ella también sirve: `memoria publicar` va entonces nota a nota.

La pasarela llama al servidor con el token de ese agente (una credencial por agente: README, «One credential per
agent») y devuelve su resultado. Si el servidor pide confirmación (`elicitation/create`), la CLI la pregunta en una
terminal y la rechaza fuera de ella.

Los nombres de entorno `BADULAQUE_*` son configuración de esa pasarela, no una dependencia de este repositorio:
cualquier pasarela que implemente el contrato anterior sirve; la de juguete de `probar.sh` son unas 30 líneas de Node.

## Instalar

```sh
nix run github:PabloPC05/cli-memoria#memoria -- --help
nix profile install github:PabloPC05/cli-memoria#memoria
```

El paquete va en `x86_64-linux`, `aarch64-linux`, `x86_64-darwin` y `aarch64-darwin`: `$out/bin/memoria` corre
`$out/lib/memoria/memoria.mjs` con Node 22. Sin Nix: copia `cli/memoria.mjs` y `cli/lib/` juntos y lánzalo con
`node memoria.mjs`.

## Probar

```sh
NODE=$(command -v node) \
MY_MEMORY=$(nix build --no-link --print-out-paths .#default)/bin/my-memory \
  cli/probar.sh

# la CLI empaquetada en vez de cli/memoria.mjs
MEMORIA=$(nix build --no-link --print-out-paths .#memoria)/bin/memoria NODE=… MY_MEMORY=… cli/probar.sh
```

Levanta un my-memory de verdad en una carpeta temporal, con notas de juguete, dos agentes y una pasarela de juguete;
prueba la lectura navegable, `buscar --en`, las fechas, la ayuda y los alias, la copia de trabajo, `publicar` (también
choques entre agentes), las herramientas por la pasarela y que ningún token salga en las salidas. Vale con un my-memory con
`publish` y sin él: dice al empezar cuál es, y las pruebas de `publicar` esperan lo que toca en cada caso. No toca ninguna memoria real. Necesita `git`, `curl`, `jq` y `rg`.

## Códigos de salida

`0` bien, `1` error de la herramienta, `2` uso o configuración, `3` red o protocolo.
