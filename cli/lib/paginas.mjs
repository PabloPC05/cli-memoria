// Salida acotada pero navegable, para la CLI memoria: ventanas de texto y listados con tope, y un aviso de una línea que
// dice siempre qué falta y cómo seguir. Nunca se corta en silencio: quien lee sabe cuántas páginas o resultados hay y con
// qué opción ver los demás. Sin dependencias. Ver cli/README.md.
//
// - Texto: ventanas de unas 150 líneas o 8.000 caracteres (lo que llegue antes), con `--pagina N`.
// - Listados: `--limite N` (resultados por página) y `--pagina N`, con el total.

import { Fallo } from "./nativa.mjs";

export const VENTANA_LINEAS = 150;
export const VENTANA_CARACTERES = 8000;

/** Un número con punto de millar al estilo español (18000 → «18.000»). */
export const miles = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/**
 * Parte unas líneas en páginas de como mucho `maxLineas` líneas y `maxCaracteres` caracteres. Una línea más larga que la
 * ventana se trocea (si no, una sola línea enorme se saldría de ella). Cada página: { desde, hasta, texto } con los
 * números de línea (de 1) de la primera y la última que toca.
 */
export function dividirEnPaginas(lineas, primeraLinea = 1, maxLineas = VENTANA_LINEAS, maxCaracteres = VENTANA_CARACTERES) {
  const paginas = [];
  let actual = null;
  const cerrar = () => {
    if (actual) paginas.push({ desde: actual.desde, hasta: actual.hasta, texto: `${actual.partes.join("\n")}\n` });
    actual = null;
  };
  lineas.forEach((linea, i) => {
    const numero = primeraLinea + i;
    const trozos = [];
    for (let j = 0; j === 0 || j < linea.length; j += maxCaracteres) trozos.push(linea.slice(j, j + maxCaracteres));
    for (const trozo of trozos) {
      if (actual && (actual.partes.length >= maxLineas || actual.caracteres + trozo.length + 1 > maxCaracteres)) cerrar();
      actual ??= { desde: numero, hasta: numero, partes: [], caracteres: 0 };
      actual.partes.push(trozo);
      actual.caracteres += trozo.length + 1;
      actual.hasta = numero;
    }
  });
  cerrar();
  return paginas;
}

/**
 * Una página de unas líneas: { texto, pie }. `pie` es la línea de aviso, p. ej.
 * «(página 1 de 3: --pagina 2 · líneas 205-310 de 612)». `lineasTotales` es el largo del documento entero (para decir
 * dónde estás); `primeraLinea`, el número de la primera de `lineas`.
 */
export function paginaDe(lineas, { primeraLinea = 1, lineasTotales = null, n = 1 } = {}) {
  const paginas = dividirEnPaginas(lineas, primeraLinea);
  if (!paginas.length) return { texto: "", pie: "(vacío)" };
  if (!Number.isInteger(n) || n < 1 || n > paginas.length) {
    throw new Fallo(`la página ${n} no existe: hay ${paginas.length}`, 2);
  }
  const p = paginas[n - 1];
  const donde = `líneas ${p.desde}-${p.hasta}${lineasTotales ? ` de ${lineasTotales}` : ""}`;
  const pie = paginas.length === 1
    ? `(${donde})`
    : n < paginas.length
      ? `(página ${n} de ${paginas.length}: --pagina ${n + 1} · ${donde})`
      : `(página ${n} de ${paginas.length}, la última · ${donde})`;
  return { texto: p.texto, pie, paginas: paginas.length };
}

/** «A-B», «A» o «A-» como rango de líneas (de 1) dentro de `total`: { desde, hasta }. */
export function rangoDe(texto, total, opcion = "--lineas") {
  const m = /^\s*(\d+)\s*(?:-\s*(\d*))?\s*$/.exec(String(texto));
  if (!m) throw new Fallo(`${opcion} es un número o un rango, p. ej. 40 o 40-120`, 2);
  const desde = Number(m[1]);
  const hasta = m[2] === undefined ? desde : m[2] === "" ? total : Number(m[2]);
  if (desde < 1 || hasta < desde) throw new Fallo(`${opcion} ${texto}: el rango no es válido (de A a B, con A ≤ B, desde 1)`, 2);
  if (desde > total) throw new Fallo(`${opcion} ${texto}: el documento tiene ${total} líneas`, 2);
  return { desde, hasta: Math.min(hasta, total) };
}

/**
 * Qué trozo de un listado de `total` resultados toca ver, con `limite` por página y la página `pagina` (desde 1):
 * { desde, hasta, pie } (rebanada [desde, hasta), pie de una línea con el total y cómo seguir).
 */
export function trozoDeListado(total, limite, pagina = 1) {
  if (!total) return { desde: 0, hasta: 0, pie: "0 resultados" };
  const por = Math.max(1, limite);
  const paginas = Math.ceil(total / por);
  if (pagina < 1 || pagina > paginas) throw new Fallo(`la página ${pagina} no existe: hay ${paginas} (${total} resultados, ${por} por página)`, 2);
  const desde = (pagina - 1) * por;
  const hasta = Math.min(total, desde + por);
  const cuantos = `${total} ${total === 1 ? "resultado" : "resultados"}`;
  let pie = cuantos;
  if (total > hasta - desde) pie += `; mostrando ${hasta - desde === 1 ? desde + 1 : `${desde + 1}-${hasta}`}`;
  if (hasta < total) pie += `: --pagina ${pagina + 1} (o --limite N)`;
  return { desde, hasta, pie };
}
