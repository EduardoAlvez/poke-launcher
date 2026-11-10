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
- **Modo leve por sessão** (`LEVE` no chip) — cena oculta e rAF limitado, sem parar a caça
  nem os lançamentos; pensado para notebook fraco.
- **Painel de caça por sessão** (`Caça` na toolbar, opt-in e só leitura) — mostra a área atual,
  o que a dex já tem e quais espécies faltam; veja o aviso abaixo.

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

### Modo leve (notebook fraco)

O Modo Economia/Ultra do jogo economiza CPU, mas **para a cena e avisa o servidor para não mandar
mais o campo** — sem campo não existe lista de captura e o AUTO não tem onde clicar. O modo leve
faz o oposto: mantém o campo chegando e corta o custo por fora.

- liga/desliga por sessão no botão **LEVE** do chip (fica azul quando ativo);
- zera `cfg-economia` e `cfg-ultra` do jogo e recarrega a sessão ao ligar (o jogo relê a escolha);
- esconde a `#cena` e pausa animações por CSS, e limita o `requestAnimationFrame` a ~3 quadros/s
  (o laço da cena se reagenda por ele); a lista de caídos é montada por timer a partir do servidor;
- ao desligar, devolve o rAF original e remove o CSS, sem recarregar. O jogo continua fora do
  Economia/Ultra até você religar no menu dele;
- a cada 20 s o launcher vigia a sessão: se o jogo voltar para Economia/Ultra pelo menu dele,
  o launcher sai pela cena (é o próprio jogo que avisa o servidor) para o campo continuar chegando.
  Com o modo leve ligado, o jogo fica fora do Economia/Ultra — inclusive quando a automação para;
- o limitador envolve o `requestAnimationFrame` global da página: se o jogo instalar o dele
  depois, o limitador é reaplicado por cima (ou o jogo passa a comando, se ele assumir o controle).

O custo esperado fica próximo do Modo Economia do jogo, mas com o `campo` ainda chegando — é isso
que permite lançar bola numa máquina fraca.

## Painel de caça (opcional, só leitura)

O botão **Caça** abre um painel por sessão que mostra a área de caça atual, quantas espécies a conta
já capturou e **quais ainda faltam** no catálogo do jogo. É **opt-in**: nada acontece até você marcar
"Ler dex desta sessão" naquela sessão.

- A leitura é feita por uma **extensão local mínima** (sem permissões, sem rede) que observa o
  WebSocket **de recebimento** do próprio jogo e repassa o estado que o jogo já manda para aquela aba.
  O launcher **nunca envia nada** nesse socket nem altera o tráfego — é só leitura do que já chega.
- A Pokédex **não é salva em disco**: o launcher só espelha, em memória, o que o servidor mandou. Fechar
  a sessão limpa tudo. Desligar o toggle apaga o espelho imediatamente.
- O opt-in mora no `localStorage` daquela partição (sessão). "Reler login" (que limpa a partição) desliga
  a leitura junto — comportamento esperado.
- Envolver o `WebSocket` da página é uma técnica **detectável em princípio** pelo jogo. É o mesmo padrão de
  extensões comunitárias já usadas no PokeIdle, mas o risco de qualquer implicação na conta é seu; por isso
  é ligado por você, sessão a sessão, e descrito aqui sem promessa de invisibilidade.

Dois modos: **intervalo fixo** e **até capturar** (para quando a captura chega até 20 s depois de um arremesso). A parada por
captura é registrada no processo principal: o `AUTO` fica vermelho, a sessão é desligada e é preciso
marcar o aviso de novo para reativar. Cada sessão usa a própria conta; a mesma conta em dois slots
derruba a primeira (o jogo fecha a sessão antiga). A automação está incluída na versão gratuita.

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
src/shared     motores puros (layout, engine de regras, automacao)
src/dexhook    micro-extensao local so-leitura do painel de caca (mundo da pagina)
src/main/rules packs de dados por jogo (CSS + regras + ancoras da automacao)
test           node:test
```

## Aviso

Projeto pessoal, sem afiliação com PokeIdle. Use por sua conta e risco; o uso de automação pode
violar os termos do jogo.
