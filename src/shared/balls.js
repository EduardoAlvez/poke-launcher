/**
 * Ordem de força das bolas que o jogo aceita no `ball.throw`. Os ids vêm do
 * próprio cliente (`SPRITE_BOLA` em poke-app.js): 1 = Poke, 2 = Great,
 * 3 = Super, 4 = Ultra, 5 = Beast — do mais fraco ao mais forte.
 *
 * O P2 arremessa a MAIS FRACA que o jogador tem. Em Modo Economia o jogo não
 * desenha o seletor de bola, então a escolha dele é inobservável: a única
 * regra reproduzível é esta. Id fora da tabela NÃO é arriscado — devolve null
 * e o motor para (fail loud), em vez de mandar um número que o servidor pode
 * recusar.
 */
export const ORDEM_BOLAS = [1, 2, 3, 4, 5];

export const NOMES_BOLAS = {
  1: 'Poke Ball',
  2: 'Great Ball',
  3: 'Super Ball',
  4: 'Ultra Ball',
  5: 'Beast Ball',
};

export function totalBolas(balls) {
  if (!balls || typeof balls !== 'object') return 0;
  let total = 0;
  for (const v of Object.values(balls)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) total += Math.floor(n);
  }
  return total;
}

/** A bola mais fraca com estoque; null quando não há nenhuma conhecida. */
export function escolherBola(balls) {
  if (!balls || typeof balls !== 'object') return null;
  for (const id of ORDEM_BOLAS) {
    const n = Number(balls[id]);
    // Inteiro >= 1: fracao nao e bola (e estoque fracionario nao existe no
    // jogo) — aceitar 0.5 aqui faria o motor arremessar com o estoque quebrado.
    if (Number.isInteger(n) && n >= 1) return id;
  }
  return null;
}

/** Desconta um arremesso do estoque (sem mutar o objeto recebido). */
export function consumirBola(balls, id) {
  if (!balls || typeof balls !== 'object') return balls;
  const n = Number(balls[id]);
  if (!Number.isFinite(n) || n <= 0) return balls;
  return { ...balls, [id]: Math.max(0, Math.floor(n) - 1) };
}
