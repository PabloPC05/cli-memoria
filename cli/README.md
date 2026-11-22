# `memoria`, la CLI de cli-memoria

cli-memoria (antes my-memory) es la memoria de Pablo como CLI con su servidor: el servidor MCP `my-memory` y la CLI
`memoria`. El nombre sigue el patrón de las CLIs del Badulaque: cada una en su repositorio `cli-<servicio>`, como su comando.

`memoria` es la memoria (las notas Markdown en git que sirve `my-memory`) como comandos de terminal, pensada para
agentes: salida compacta (una línea por resultado, con el total y cómo seguir), `--json` para filtrar con `jq`,
`--simular` en todo lo que escribe y códigos de salida estables. Sin dependencias de npm: Node 22 o más y unos `.mjs`.

Viene de `kit/memoria` de [PabloPC05/lisa](https://github.com/PabloPC05/lisa), con su historial (`git log -- cli/memoria.mjs`).

```sh
memoria buscar badulaque --carpeta projects --limite 5
memoria leer badulaque --seccion pendiente
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
├─ probar.sh         prueba de punta a punta contra un my-memory de verdad, con notas y agentes de juguete
└─ README.md         esto
nix/memoria.nix      el paquete `memoria` del flake
```

`lib/` son copias de `kit/badulaque/nativa.mjs`, `kit/badulaque/paginas.mjs` y un trozo de `kit/badulaque/badulaque.mjs`
de lisa, que las comparte con sus otras CLIs (correo, archivos…). Lo que se arregle aquí y les sirva a ellas, se lleva
allí a mano (y al revés).

## Cómo lee y cómo escribe

- **Leer** (`buscar`, `leer`, `lista`, `recientes`): con `MEMORIA_DIR`, directamente en una copia del repositorio de
  notas (basta de solo lectura), con `rg` y `git`, sin pasar por MCP. Sin `MEMORIA_DIR`, las mismas lecturas por la
  pasarela (`search`, `read`, `list` y `recent` de my-memory).
- **Escribir** siempre lo hace el servidor (firma con la credencial del agente y aplica las reglas de `memory.toml`):
  - una nota cada vez, por la pasarela: `crear`, `editar`, `escribir`, `mover`, `borrar`, `revertir`, `adjuntar`;
  - como en un ordenador (hace falta `MEMORIA_DIR`): `memoria copia` hace un `git clone` de trabajo, se edita y se
    commitea con git, y `memoria publicar` lleva esos commits al servidor nota a nota, con el hash de cada una para no
    pisar cambios ajenos. `memoria estado` y `memoria actualizar` completan el ciclo.
- **El resto** del servidor, por la pasarela: `historial`, `enlaces`, `revisar` (lint).

## Configuración

| Variable | Para qué | Si falta |
|---|---|---|
| `MEMORIA_DIR` | La carpeta del repositorio de notas para leer en local (y para la copia de trabajo) | Todo va por la pasarela |
| `MEMORIA_COPIA` | Dónde vive la copia de trabajo de `memoria copia` | `~/memoria` |
| `BADULAQUE_URL` | La dirección MCP de la pasarela | `https://badulaque.ppardocotos.com/buscador/mcp` (la de Pablo) |
| `BADULAQUE_CLAVE` | La clave del agente en la pasarela (`Authorization: Bearer`) | Lo que necesite la pasarela falla con código 2 |

`rg` y `git` tienen que estar en el `PATH` para leer en local y para la copia de trabajo (el paquete de Nix los añade
al final del `PATH`).

### La pasarela

La CLI no habla con `my-memory` directamente: habla MCP con una **pasarela**, un punto MCP por HTTP que la autentica
con una clave por agente y que tiene una herramienta `buscador_usar` con dos argumentos:

- `nombre`: `memoria_<herramienta>`, donde `<herramienta>` es una de my-memory (`search`, `read`, `list`, `recent`,
  `create`, `edit`, `write`, `move`, `delete`, `revert`, `attach`, `history`, `links`, `lint`);
- `argumentos`: los de esa herramienta, tal cual.

La pasarela llama a my-memory con el token de ese agente (una credencial por agente: README, «One credential per
agent») y devuelve su resultado. Si el servidor pide confirmación (`elicitation/create`), la CLI la pregunta en una
terminal y la rechaza fuera de ella.

En la instalación de Pablo esa pasarela es **el Badulaque** de lisa (Caddy, agentgateway y su buscador), y de ahí
vienen los nombres `BADULAQUE_*` y los mensajes que lo nombran: es configuración, no una dependencia de este
repositorio. Cualquier otra sirve si cumple lo de arriba; la de juguete de `probar.sh` son unas 30 líneas de Node.

## Instalar

```sh
nix run github:PabloPC05/cli-memoria#memoria -- --help
nix profile install github:PabloPC05/cli-memoria#memoria
```

El paquete va en `x86_64-linux`, `aarch64-linux`, `x86_64-darwin` y `aarch64-darwin`: `$out/bin/memoria` corre
`$out/lib/memoria/memoria.mjs` con Node 22. Sin Nix: copia `cli/memoria.mjs` y `cli/lib/` juntos y lánzalo con
`node memoria.mjs`.

### En lisa

`kit-clis` (el kit de CLIs de lisa y del Mac) toma este paquete de la entrada `my-memory` de su flake y lo envuelve
con su `kit/envoltorio.nix`, igual que a sus otras CLIs nativas: la CA de srt en `NODE_EXTRA_CA_CERTS` y
`NODE_USE_ENV_PROXY=1` para salir por su proxy. Lo demás de lisa sigue allí: la entrada de `kit/clis.json` (dominios,
credenciales, la ruta que se monta en solo lectura como `MEMORIA_DIR`) y la guía de los agentes (`kit/AGENTS.md`).
La disposición del paquete (`lib/memoria/memoria.mjs` y `lib/memoria/lib/`) es lo que lisa usa: no la cambies sin
cambiar allí `kit/paquetes.nix`.

## Probar

```sh
NODE=$(command -v node) \
MY_MEMORY=$(nix build --no-link --print-out-paths .#default)/bin/my-memory \
  cli/probar.sh

# la CLI empaquetada en vez de cli/memoria.mjs
MEMORIA=$(nix build --no-link --print-out-paths .#memoria)/bin/memoria NODE=… MY_MEMORY=… cli/probar.sh
```

Levanta un my-memory de verdad en una carpeta temporal, con notas de juguete, dos agentes y una pasarela de juguete;
prueba la lectura navegable, la copia de trabajo, `publicar` (también choques entre agentes), las herramientas por la
pasarela y que ningún token salga en las salidas. No toca ninguna memoria real. Necesita `git`, `curl`, `jq` y `rg`.

## Códigos de salida

`0` bien, `1` error de la herramienta, `2` uso o configuración, `3` red o protocolo.
