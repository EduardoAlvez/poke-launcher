# Changelog

## [0.2.6] - 2026-11-11

### Melhorado

- Reduz o desenho da cena a 5 FPS na grade com várias sessões e a 1 FPS nas sessões ocultas, preservando timers e rede; o modo Foco restaura a taxa normal da sessão selecionada.

## [0.2.5] - 2026-11-11

### Adicionado

- Redesign do painel com tema claro, status das sessões, modo foco e tipografia IBM Plex Sans.
- Modo VIP na rota: viaja até cada alvo e espera a confirmação da captura sem arremessar Poké Bolas.

### Corrigido

- Formulário de nova sessão permanece visível acima das telas do jogo ao abrir pelo botão `+`.
- Barra do sistema sem menu File/Edit e sem o nome do launcher ao lado das sessões.

## [0.2.4] - 2026-11-11

### Adicionado

- Modo foco para ampliar uma sessão na área do launcher, alternar entre sessões ativas e sair com Escape.

### Corrigido

- A rota de captura permanece no Pokémon atual até confirmar a captura, sem avançar por tempo esgotado.
- Se não localizar o alvo, não confirmar a chegada ou atingir o limite de arremessos, a rota para no alvo atual e informa o motivo.
