# Poke Launcher

Launcher desktop de múltiplas sessões para jogos idle online, começando pelo [PokeIdle](https://pokeidle.io/app).
Cada sessão roda em uma partição isolada (login/progresso separados), em grade, com bandeja e
notificações nativas.

Não é afiliado ao PokeIdle nem aos criadores do jogo.

## Instalação

Baixe o instalador na página de releases:
[github.com/EduardoAlvez/poke-launcher/releases](https://github.com/EduardoAlvez/poke-launcher/releases)

- Windows: `Poke Launcher Setup <versão>.exe` (NSIS, instalador para o usuário final).
- O instalador **não é assinado** (sem certificado de código): o Windows pode mostrar o aviso do
  SmartScreen. Clique em "Mais informações" → "Executar assim mesmo".
- Linux: pacote `.deb` (gerado com `npm run dist`).

## Recursos

- **Sessões isoladas**: até 8 contas lado a lado, cada uma com cookies/armazenamento próprios
  (`persist:slot-N`). Adicionar e remover pela toolbar, renomear com duplo clique no nome.
- **Menu do chip** (clique direito): silenciar a sessão, zoom de 75% a 150% e **reler login**
  (limpa cookies e armazenamento só daquela conta; as outras sessões não mudam).
- **Grade ajustável**: 1, 2 ou 3 colunas (o padrão é 2).
- **Bandeja**: fecha para a bandeja com `X`; menu com Abrir, Silenciar, Parar automações e Encerrar.
- **Notificações nativas** por evento do jogo (captura, poucas bolas, boss, ovo), com cooldown,
  limite de taxa e botão de silenciar na bandeja.
- **Sessões continuam rodando** minimizadas, na bandeja e com a tela travada
  (`backgroundThrottling: false`).
- **Addons por jogo** (carregados como dados, sem código remoto):
  - UI compacta no chat e nos painéis do PokeIdle;
  - extensão `/hunt for PokeIdle` baixada da Chrome Web Store e carregada por sessão;
  - regras de notificação com âncoras por classe CSS.
- **Automação de lançamentos (opt-in)** — veja o aviso abaixo.
- **Modo leve por sessão** (`LEVE` no chip) — cena oculta e rAF limitado, **sem recarregar** e sem
  parar a caça nem os lançamentos; a sua preferência de Economia/Ultra é guardada e devolvida no fim.
  Pensado para notebook fraco.
- **Painel de caça por sessão** (`Caça` na toolbar, opt-in) — mostra a área atual,
  o que a dex já tem e quais espécies faltam; e a **rota "capturar um por um"** (automação opt-in
  que viaja e captura os faltantes em fila). Veja os avisos abaixo.
- **P2: arremessar dentro do Modo Economia** (opt-in, desligado por padrão) — escreve no socket do
  jogo; exige consentimento na hora. Veja os avisos abaixo.

## Automação: leia antes de usar

A automação de lançamentos é **opcional, desligada por padrão e exige consentimento explícito**
(uma caixa de confirmação dentro do app, por sessão).

> Automatizar ações viola os Termos de Uso do PokeIdle e pode resultar em **ban permanente** da conta.
> O launcher **não promete evitar detecção**: intervalo aleatório (jitter) e limites reduzem padrões,
> mas não garantem nada. Você pode perder contas, itens e progresso. A decisão é sua.

Garantias de projeto (não de resultado):

- nunca liga sozinha; sem consentimento, o botão não ativa;
- tem indicador visível por sessão (`AUTO` aceso, vermelho quando parou) e **Parar automações** na toolbar e na bandeja;
- o laço roda no mundo isolado da página, com pausa por seletor/texto e limite por minuto;
- sai do **Modo Economia** enquanto ativa (opção no modal): sem a cena o servidor não manda o campo
  e não existe alvo para lançar; ao parar, volta ao modo economia;
- o kill switch interrompe em menos de 500 ms.

Dois modos: **intervalo fixo** e **até capturar** (para quando a captura chega até 20 s depois de um arremesso). A parada por
captura é registrada no processo principal: o `AUTO` fica vermelho, a sessão é desligada e é preciso
marcar o aviso de novo para reativar. Cada sessão usa a própria conta; a mesma conta em dois slots
derruba a primeira (o jogo fecha a sessão antiga). A automação está incluída na versão gratuita.

### Modo leve (notebook fraco)

O Modo Economia/Ultra do jogo economiza CPU, mas **para a cena e avisa o servidor para não mandar
mais o campo** — sem campo não existe lista de captura e o AUTO não tem onde clicar. O modo leve
faz o oposto: mantém o campo chegando e corta o custo por fora.

- liga/desliga por sessão no botão **LEVE** do chip (fica azul quando ativo);
- **sem recarregar**: se o jogo estiver em Economia/Ultra, o launcher sai pelo **botão do próprio
  jogo** ("Ligar a cena"), que é quem avisa o servidor para voltar a mandar o campo;
- **a sua preferência volta no fim**: o launcher guarda se você tinha Economia/Ultra ligado **antes**
  de mexer no jogo (o botão do jogo zera a chave ao sair). Ao desligar o modo leve, a preferência é
  religada pelo atalho da cena. Se o AUTO ou a rota ainda estiverem rodando, a volta é **adiada**
  para quando eles pararem — o chip avisa isso no tooltip;
- esconde a `#cena` e pausa animações por CSS, e limita o `requestAnimationFrame` a ~3 quadros/s
  (o laço da cena se reagenda por ele); a lista de caídos é montada por timer a partir do servidor;
- ao desligar, devolve o rAF original e remove o CSS, sem recarregar;
- a cada 20 s o launcher vigia a sessão: se o jogo voltar para Economia/Ultra pelo menu dele,
  o launcher sai pela cena (é o próprio jogo que avisa o servidor) para o campo continuar chegando.
  Com o modo leve ligado, o jogo fica fora do Economia/Ultra — inclusive quando a automação para;
- o limitador envolve o `requestAnimationFrame` global da página: se o jogo instalar o dele
  depois, o limitador é reaplicado por cima (ou o jogo passa a comando, se ele assumir o controle);
- se o jogo **não tiver** o botão de sair do Economia (versão diferente), o launcher cai no último
  recurso: zera `cfg-economia`/`cfg-ultra` e recarrega a sessão uma vez, com trava de 10 s para não
  entrar em loop.

Com o modo leve ligado, o **AUTO não mexe** na sua preferência de Economia (é o launcher que a
guarda e devolve): sem isso os dois brigariam e o campo pararia de chegar.

O custo esperado fica próximo do Modo Economia do jogo, mas com o `campo` ainda chegando — é isso
que permite lançar bola numa máquina fraca.

## Painel de caça (opcional)

O botão **Caça** abre um painel por sessão que mostra a área de caça atual, quantas espécies a conta
já capturou e **quais ainda faltam** no catálogo do jogo. É **opt-in**: nada acontece até você marcar
"Ler dex desta sessão" naquela sessão.

- A leitura é feita por uma **extensão local mínima** (sem permissões, sem rede) que observa o
  WebSocket **de recebimento** do próprio jogo e repassa o estado que o jogo já manda para aquela aba.
  Por padrão o launcher **apenas lê** nesse socket e **não altera o tráfego**. A única exceção é o
  **P2** (seção abaixo), que **escreve** no socket — e só quando você arma na hora.
- A Pokédex **não é salva em disco**: o launcher só espelha, em memória, o que o servidor mandou. Fechar
  a sessão limpa tudo. Desligar o toggle apaga o espelho imediatamente.
- O opt-in mora no `localStorage` daquela partição (sessão). "Reler login" (que limpa a partição) desliga
  a leitura junto — comportamento esperado.
- Envolver o `WebSocket` da página é uma técnica **detectável em princípio** pelo jogo. É o mesmo padrão de
  extensões comunitárias já usadas no PokeIdle, mas o risco de qualquer implicação na conta é seu; por isso
  é ligado por você, sessão a sessão, e descrito aqui sem promessa de invisibilidade.

### Rota de captura ("capturar um por um")

No mesmo painel, a **Rota** usa a lista de faltantes para trabalhar a dex sozinha: o launcher abre o
Mapa, troca de região quando precisa, viaja até a caçada do alvo e arremessa em cada caído da espécie
até capturar — então passa ao próximo alvo da fila (ordem por nível/XP/região, limite de alvos).

- É **automação completa**: os mesmos riscos da seção de Automação acima, com comportamento mais robusto
  de bot (viagem + captura em série). Detectável em princípio; o risco de ban é seu.
- **Custo real de bolas**: capturar espécies novas pode exigir centenas/milhares de arremessos por
  espécie. A rota lê o estoque da bola selecionada direto no DOM a cada arremesso e **para quando ele
  zera** (o `welcome` do jogo congela esse número, então não confiaríamos nele). Ainda assim, comece
  com poucos alvos.
- A rota **não escreve no socket**: cada passo é clique de usuário simulado no DOM, como o AUTO já faz;
  a confirmação de captura vem do delta real da dex (a leitura do painel precisa estar ligada).
- Botão **Parar rota** no painel, **Parar automações** na toolbar/bandeja também derruba a rota, e o
  kill switch vale igual.

### P2 — arremessar dentro do Modo Economia (opt-in, desligado por padrão)

O **P2** é a única parte do launcher que **escreve no WebSocket do jogo**: ele manda
`ball.throw` pelo socket, com o jogo **permanecendo no Modo Economia**.

- É **opt-in e desligado por padrão**: para usar, você precisa da leitura da dex ligada na sessão,
  o jogo **no Modo Economia** (e não no ULTRA), abrir o painel **Caça**, marcar a caixa de risco do P2
  e **armar na hora**. Nada é armado sozinho; o consentimento é **por execução** (cada novo uso exige
  marcar a caixa de novo) e **não é salvo em disco**.
- **Por que é mais arriscado que a rota**: a rota só simula cliques no DOM; o P2 escreve mensagens que
  o servidor não esperava de um cliente declarado fora do Economia. Automatizar viola os Termos de Uso
  do PokeIdle e pode resultar em **ban permanente** da conta. O risco é seu.
- **Gasta bolas de verdade**: o teto de arremessos é **você que define** (padrão 30 por execução) e
  nunca passa do estoque que você tinha no login. Cada arremesso leva alguns segundos (2,5–5 s com
  intervalo aleatório).
- Enquanto o P2 está armado, o launcher **não tira o jogo do Modo Economia** (a rota e a automação de
  lançamentos ficam desligadas) e o botão de ligar o modo leve é recusado. Ao desarmar — ou a cada
  recarga da aba — o controle volta ao jogo.
- Se o servidor não confirmar o arremesso em 6 s, o P2 **desarma sozinho** e devolve o controle ao
  jogo. Ele nunca desliga a sua preferência de Economia/Ultra: o P2 não toca no menu do jogo.

## Requisitos

- Node.js 20+ e npm
- Windows 10/11 (principal) ou Linux (deb)

## Desenvolvimento

```bash
npm install
npm start        # abre o launcher
npm test         # testes (layout, store, notificacoes, addon, automacao, scripts/eco, painel de caca)
npm run dist     # gera instalador (Windows: NSIS; Linux: deb)
```

## Dados e privacidade

Tudo é local. O estado fica em `app.getPath('userData')` (`slots.json` + backup `.bak`), os cookies
ficam nas partições do Chromium, a extensão é extraída em `userData/extensions` e o hook do painel
de caça em `userData/dexhook`. O diagnóstico fica em `launcher.log` na mesma pasta (rotacionado em
1 MB), inclusive os avisos do processo principal. A Pokédex vista no painel **não é gravada**: vive
só em memória enquanto a sessão estiver aberta. Nenhum dado é enviado para servidores do launcher.

## Estrutura

```
src/main       processo principal (janela, grade, store, tray, addons, automacao)
src/preload    bridges sandboxed (CJS): chrome.cjs (UI) e addon.cjs (pagina do jogo)
src/renderer   toolbar/grade (HTML/CSS/JS puro)
src/shared     motores puros (layout, engine de regras, automacao, rota de captura)
src/dexhook    micro-extensao local do painel de caca (leitura; e o P2, so com arm por execucao)
src/main/rules packs de dados por jogo (CSS + regras + ancoras da automacao)
test           node:test
```

## Aviso

Projeto pessoal, sem afiliação com PokeIdle. Use por sua conta e risco; o uso de automação pode
violar os termos do jogo.
