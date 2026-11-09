export const ZOOM_STEPS = [0.75, 0.9, 1, 1.1, 1.25, 1.5];

/**
 * Template do menu de contexto do chip. Fica fora do index.js para ser
 * testavel sem subir o Electron: so descreve itens e chama as acoes.
 */
export function buildSlotMenu(slot, actions = {}) {
  const zoom = Number(slot?.zoomFactor) || 1;
  const auto = slot?.automation?.enabled === true;
  return [
    { label: slot?.name ?? 'Sessao', enabled: false },
    { type: 'separator' },
    {
      label: 'Silenciar',
      type: 'checkbox',
      checked: slot?.muted === true,
      click: () => actions.onMute?.(slot?.muted !== true),
    },
    {
      label: 'Zoom',
      submenu: ZOOM_STEPS.map((step) => ({
        label: `${Math.round(step * 100)}%`,
        type: 'radio',
        checked: Math.abs(zoom - step) < 0.001,
        click: () => actions.onZoom?.(step),
      })),
    },
    {
      label: 'Modo eco (reduz CPU)',
      type: 'checkbox',
      checked: slot?.eco === true,
      click: () => actions.onEco?.(slot?.eco !== true),
    },
    { type: 'separator' },
    { label: 'Renomear…', click: () => actions.onRename?.() },
    {
      label: auto ? 'Reler login (pare a automacao antes)' : 'Reler login (limpar dados)',
      enabled: !auto,
      click: () => actions.onReset?.(),
    },
  ];
}
