# Poke Launcher

Launcher desktop de múltiplas sessões para jogos idle online, começando pelo [PokeIdle](https://pokeidle.io/app).
Cada sessão roda em uma partição isolada (login/progresso separados), em grade, com bandeja e
notificações nativas.

Não é afiliado ao PokeIdle nem aos criadores do jogo.

## Recursos

- **Sessões isoladas**: até 8 contas lado a lado, cada uma com cookies/armazenamento próprios
  (`persist:slot-N`). Adicionar, renomear e remover pela toolbar.
- **Grade ajustável**: 1, 2 ou 3 colunas (o padrão é 2).
- **Bandeja**: fecha para a bandeja com `X`; menu com Abrir, Silenciar, Parar automações e Encerrar.
- **Notificações nativas** por evento do jogo (captura, poucas bolas, boss, ovo), com cooldown,
  limite de taxa, horário de silêncio e botão de silenciar.
- **Sessões continuam rodando** minimizadas, na bandeja e com a tela travada
  (`backgroundThrottling: false`).
- **Addons por jogo** (carregados como dados, sem código remoto):
  - UI compacta no chat e nos painéis do PokeIdle;
  - extensão `/hunt for PokeIdle` baixada da Chrome Web Store e carregada por sessão;
  - regras de notificação com âncoras por classe CSS.
- **Automação de lançamentos (opt-in)** — veja o aviso abaixo.

## Automação: leia antes de usar

A automação de lançamentos é **opcional, desligada por padrão e exige consentimento explícito**
(uma caixa de confirmação dentro do app, por sessão).

> Automatizar ações viola os Termos de Uso do PokeIdle e pode resultar em **ban permanente** da conta.
> O launcher **não promete evitar detecção**: intervalo aleatório (jitter) e limites reduzem padrões,
> mas não garantem nada. Você pode perder contas, itens e progresso. A decisão é sua.

Garantias de projeto (não de resultado):

- nunca liga sozinha; sem consentimento, o botão não ativa;
- tem indicador visível por sessão (`AUTO` aceso) e **Parar automações** na toolbar e na bandeja;
- o laço roda no mundo isolado da página, com pausa por seletor/texto e limite por minuto;
- o kill switch interrompe em menos de 500 ms.

Dois modos: **intervalo fixo** e **até capturar** (para após detectar uma captura).
A automação está incluída na versão gratuita.

## Requisitos

- Node.js 20+ e npm
- Windows 10/11 (principal) ou Linux (deb)

## Desenvolvimento

```bash
npm install
npm start        # abre o launcher
npm test         # testes (layout, store, notificacoes, addon, automacao)
npm run dist     # gera instalador (Windows: NSIS; Linux: deb)
```

## Dados e privacidade

Tudo é local. O estado fica em `app.getPath('userData')` (`state.json` + backup `.bak`), os cookies
ficam nas partições do Chromium e a extensão é extraída em `userData/extensions`. Nenhum dado é
enviado para servidores do launcher.

## Estrutura

```
src/main       processo principal (janela, grade, store, tray, addons, automacao)
src/preload    bridges sandboxed (CJS): chrome.cjs (UI) e addon.cjs (pagina do jogo)
src/renderer   toolbar/grade (HTML/CSS/JS puro)
src/shared     motores puros (layout, engine de regras, automacao)
src/main/rules packs de dados por jogo (CSS + regras + ancoras da automacao)
test           node:test
```

## Aviso

Projeto pessoal, sem afiliação com PokeIdle. Use por sua conta e risco; o uso de automação pode
violar os termos do jogo.
