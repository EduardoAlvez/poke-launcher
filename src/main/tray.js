import { Menu, Tray, nativeImage } from 'electron';

export function createTray({ iconPath, onShow, onToggleMute, isMuted, onQuit }) {
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  const tray = new Tray(icon);
  let muted = isMuted;

  const buildMenu = () =>
    Menu.buildFromTemplate([
      { label: 'Abrir launcher', click: () => onShow() },
      { type: 'separator' },
      {
        label: 'Silenciar notificacoes',
        type: 'checkbox',
        checked: muted,
        click: (item) => {
          muted = item.checked;
          onToggleMute(muted);
          tray.setContextMenu(buildMenu());
        },
      },
      { type: 'separator' },
      { label: 'Encerrar', click: () => onQuit() },
    ]);

  tray.setToolTip('Poke Launcher');
  tray.setContextMenu(buildMenu());
  tray.on('click', () => onShow());

  return {
    tray,
    setMuted(value) {
      muted = value;
      tray.setContextMenu(buildMenu());
    },
    destroy() {
      tray.destroy();
    },
  };
}
