const chips = document.getElementById('chips');
const form = document.getElementById('add-form');
const addBtn = document.getElementById('add');
const nameInput = document.getElementById('add-name');
const urlInput = document.getElementById('add-url');
const error = document.getElementById('add-error');
const modal = document.getElementById('modal');
const modalSlot = document.getElementById('modal-slot');
const modalRisk = document.getElementById('modal-risk');
const modalConsent = document.getElementById('modal-consent');
const modalExitEco = document.getElementById('modal-exit-eco');
const modalMode = document.getElementById('modal-mode');
const modalInterval = document.getElementById('modal-interval');
const modalJitter = document.getElementById('modal-jitter');
const modalMax = document.getElementById('modal-max');
const modalError = document.getElementById('modal-error');
const modalSave = document.getElementById('modal-save');
const stopAllBtn = document.getElementById('stop-all');
const closePopupsBtn = document.getElementById('close-popups');
const diagBtn = document.getElementById('diagnostics');
const diagStatus = document.getElementById('diag-status');
const focusBtn = document.getElementById('focus-btn');
const focusModal = document.getElementById('focus-modal');
const focusSlotList = document.getElementById('focus-slot-list');
const focusEnterBtn = document.getElementById('focus-enter');
const focusCancelBtn = document.getElementById('focus-cancel');
const focusError = document.getElementById('focus-error');
const layoutBtns = document.getElementById('layout-btns');
const focusContext = document.getElementById('focus-context');
const focusContextLabel = document.getElementById('focus-context-label');
const focusContextStatus = document.getElementById('focus-context-status');
const toolbarStatus = document.getElementById('toolbar-status');
const toolbarStatusLabel = document.getElementById('toolbar-status-label');
const toolbarSlotCount = document.getElementById('toolbar-slot-count');
const toolbar = document.getElementById('toolbar');
const toolbarToggle = document.getElementById('toolbar-toggle');
const toolbarToggleIcon = document.getElementById('toolbar-toggle-icon');
let editingSlot = null;
let riskReady = false;
let lastSlots = [];
let focusedSlotId = null;
let selectedFocusSlotId = null;

toolbarToggle.addEventListener('click', () => {
  const collapsed = !toolbar.classList.contains('collapsed');
  toolbar.classList.toggle('collapsed', collapsed);
  toolbarToggle.setAttribute('aria-expanded', String(!collapsed));
  toolbarToggle.setAttribute('aria-label', collapsed ? 'Mostrar barra superior' : 'Recolher barra superior');
  toolbarToggle.title = collapsed ? 'Mostrar barra superior' : 'Recolher barra superior';
  toolbarToggleIcon.textContent = collapsed ? '⌄' : '⌃';
  window.launcher.setToolbarCollapsed(collapsed);
});

let chipsPointer = null;
let draggedChip = null;
let clearDraggedChipTimer = null;

chips.addEventListener('wheel', (event) => {
  const maxScroll = chips.scrollWidth - chips.clientWidth;
  if (maxScroll <= 0) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;
  const next = Math.max(0, Math.min(maxScroll, chips.scrollLeft + delta));
  if (next !== chips.scrollLeft) {
    chips.scrollLeft = next;
    event.preventDefault();
  }
}, { passive: false });

chips.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button, input')) return;
  draggedChip = null;
  clearTimeout(clearDraggedChipTimer);
  chipsPointer = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    scrollLeft: chips.scrollLeft,
    chip: event.target.closest('.chip'),
    dragging: false,
  };
});

chips.addEventListener('pointermove', (event) => {
  if (!chipsPointer || event.pointerId !== chipsPointer.id) return;
  const dx = event.clientX - chipsPointer.x;
  const dy = event.clientY - chipsPointer.y;
  if (!chipsPointer.dragging && Math.abs(dx) > 5 && Math.abs(dx) > Math.abs(dy)) {
    chipsPointer.dragging = true;
    chips.classList.add('dragging');
    chips.setPointerCapture(event.pointerId);
  }
  if (chipsPointer.dragging) chips.scrollLeft = chipsPointer.scrollLeft - dx;
});

function endChipsPointer(event) {
  if (!chipsPointer || (event && event.pointerId !== chipsPointer.id)) return;
  if (chipsPointer.dragging) {
    draggedChip = chipsPointer.chip;
    chips.classList.remove('dragging');
    if (event && chips.hasPointerCapture(event.pointerId)) chips.releasePointerCapture(event.pointerId);
    clearDraggedChipTimer = setTimeout(() => { draggedChip = null; }, 200);
  }
  chipsPointer = null;
}

chips.addEventListener('pointerup', endChipsPointer);
chips.addEventListener('pointercancel', endChipsPointer);
chips.addEventListener('click', (event) => {
  if (!event.detail || !draggedChip || event.target.closest('.chip') !== draggedChip) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  draggedChip = null;
  clearTimeout(clearDraggedChipTimer);
}, true);

modalSave.disabled = true;
window.launcher
  .riskText()
  .then((text) => {
    modalRisk.textContent = text || '';
    riskReady = Boolean(text);
  })
  .catch(() => {
    riskReady = false;
  })
  .finally(() => {
    modalSave.disabled = !riskReady;
    modalError.textContent = riskReady ? '' : 'Nao foi possivel carregar o aviso de risco';
  });

document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !scriptsModal.hidden) closeScriptsModal();
  else if (e.key === 'Escape' && !focusModal.hidden) closeFocusChooser();
  else if (e.key === 'Escape' && !modal.hidden) closeModal();
  else if (e.key === 'Escape' && !closePopupsBtn.hidden) window.launcher.closePopups();
  else if (e.key === 'Escape' && focusedSlotId) exitFocusMode();
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
modalSave.addEventListener('click', async () => {
  modalError.textContent = '';
  if (!modalConsent.checked) {
    if (editingSlot?.automation?.enabled) {
      modalSave.disabled = true;
      try {
        await disableSlotAutomation(editingSlot);
        closeModal();
      } finally {
        modalSave.disabled = false;
      }
      return;
    }
    modalError.textContent = 'Confirme o aviso de risco para ativar';
    return;
  }
  if (!riskReady) {
    modalError.textContent = 'Aviso de risco indisponivel';
    return;
  }
  const config = {
    enabled: true,
    consent: true,
    exitEconomy: modalExitEco.checked,
    mode: modalMode.value,
    intervalMs: Number(modalInterval.value),
    jitterMs: Number(modalJitter.value),
    maxPerMin: Number(modalMax.value),
  };
  modalSave.disabled = true;
  try {
    const res = await window.launcher.setAutomation(editingSlot.id, config);
    if (!res?.ok) {
      modalError.textContent = res?.error || 'Falha ao salvar';
      return;
    }
    closeModal();
  } catch (err) {
    modalError.textContent = err?.message ?? 'Falha ao salvar';
  } finally {
    modalSave.disabled = false;
  }
});

function disableSlotAutomation(slot) {
  return window.launcher.setAutomation(slot.id, { ...slot.automation, enabled: false, consent: false });
}

stopAllBtn.addEventListener('click', async () => {
  await window.launcher.stopAllAutomation();
});

closePopupsBtn.addEventListener('click', async () => {
  await window.launcher.closePopups();
});

diagBtn.addEventListener('click', async () => {
  diagBtn.disabled = true;
  diagStatus.textContent = 'coletando…';
  try {
    const res = await window.launcher.runDiagnostics();
    diagStatus.textContent = res?.ok ? `salvo em ${res.file}` : 'falhou';
  } catch {
    diagStatus.textContent = 'falhou';
  } finally {
    diagBtn.disabled = false;
  }
});

function openModal(slot) {
  editingSlot = slot;
  modalSlot.textContent = `Sessão: ${slot.name}`;
  modalConsent.checked = slot.automation?.enabled === true;
  modalExitEco.checked = slot.automation?.exitEconomy !== false;
  // Com o modo leve ligado, quem decide a preferencia de Economia e o
  // launcher (ele a lembra e devolve). Deixar a caixa editavel mostraria uma
  // escolha que nao tem efeito nenhum.
  modalExitEco.disabled = slot.lightMode === true;
  modalExitEco.parentElement.classList.toggle('desativado', slot.lightMode === true);
  modalExitEco.parentElement.title = slot.lightMode === true
    ? 'Com o modo leve ligado, o launcher e quem guarda e devolve a preferencia de Economia.'
    : '';
  modalMode.value = slot.automation?.mode ?? 'fixed';
  modalInterval.value = slot.automation?.intervalMs ?? 2000;
  modalJitter.value = slot.automation?.jitterMs ?? 800;
  modalMax.value = slot.automation?.maxPerMin ?? 20;
  modalError.textContent = slot.autoState === 'captured' && !slot.automation?.enabled
    ? 'A automacao parou ao capturar. Marque o aviso para ativar de novo.'
    : '';
  modal.hidden = false;
  window.launcher.setViewsVisible(false);
  (modalConsent.checked ? modalSave : modalConsent).focus();
}

function closeModal() {
  modal.hidden = true;
  editingSlot = null;
  window.launcher.setViewsVisible(true);
}

/**
 * Nome padrao da nova conta: "Conta 1", "Conta 2"... sequencial e sem colidir
 * com quem ja existe (se o usuario renomeou, o proximo numero continua o
 * maior em uso). Vem preenchido no campo: para criar conta, so aperta Enter.
 */
function proximoNomeConta() {
  const usados = new Set(lastSlots.map((s) => (s.name || '').trim().toLowerCase()));
  let maior = 0;
  for (const s of lastSlots) {
    const m = /^conta\s*(\d+)$/i.exec((s.name || '').trim());
    if (m) maior = Math.max(maior, Number(m[1]));
  }
  let n = maior + 1;
  while (usados.has(`conta ${n}`)) n += 1;
  return `Conta ${n}`;
}

addBtn.addEventListener('click', () => {
  form.hidden = false;
  addBtn.hidden = true;
  nameInput.value = proximoNomeConta();
  nameInput.focus();
  nameInput.select();
});
document.getElementById('add-cancel').addEventListener('click', closeForm);
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  urlInput.style.borderColor = '';
  try {
    await window.launcher.addSlot(nameInput.value.trim(), urlInput.value.trim());
  } catch (err) {
    error.textContent = err.message || 'Falha ao criar sessao';
    urlInput.style.borderColor = '#ff6b6b';
    return;
  }
  nameInput.value = '';
  closeForm();
});

function closeForm() {
  form.hidden = true;
  addBtn.hidden = false;
  urlInput.style.borderColor = '';
}

document.querySelectorAll('#layout-btns button').forEach((btn) => {
  btn.addEventListener('click', () => {
    setLayoutSelection(Number(btn.dataset.cols));
    window.launcher.setLayout(Number(btn.dataset.cols));
  });
});

function setLayoutSelection(cols) {
  for (const btn of layoutBtns.querySelectorAll('button')) {
    const active = Number(btn.dataset.cols) === cols;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

function syncFocusButton() {
  const active = Boolean(focusedSlotId);
  const slot = lastSlots.find((item) => item.id === focusedSlotId);
  focusBtn.textContent = active ? 'Sair do foco' : 'Foco';
  focusBtn.classList.toggle('focus-active', active);
  focusBtn.setAttribute('aria-pressed', String(active));
  focusBtn.title = active ? 'Voltar à grade de sessões (Esc)' : 'Escolher uma sessão para ampliar';
  layoutBtns.hidden = active;
  focusContext.hidden = !active;
  if (active) {
    focusContextLabel.textContent = `PokeIdle / ${slot?.name || 'Sessão'}`;
    focusContextStatus.textContent = slot?.loggedIn ? 'Conta conectada' : 'Sessão ativa';
  }
}

function syncToolbarStatus(slots) {
  const routeActive = slots.some((slot) => slot.route?.running === true);
  const automationActive = slots.some((slot) => slot.automation?.enabled === true);
  const crashed = slots.some((slot) => slot.crashedUntil > Date.now());
  const status = routeActive ? 'route' : automationActive ? 'automation' : crashed ? 'attention' : 'ready';
  toolbarStatus.dataset.state = status;
  toolbarStatusLabel.textContent = routeActive
    ? 'Rota ativa'
    : automationActive
      ? 'Automação ativa'
      : crashed
        ? 'Reconectando sessão'
        : 'Launcher pronto';
  toolbarSlotCount.textContent = `${slots.length} ${slots.length === 1 ? 'sessão' : 'sessões'} ativa${slots.length === 1 ? '' : 's'}`;
}

function selectFocusSlot(id) {
  selectedFocusSlotId = id;
  for (const option of focusSlotList.querySelectorAll('.focus-option')) {
    option.setAttribute('aria-checked', String(option.dataset.slotId === id));
  }
  focusEnterBtn.disabled = !id;
}

function renderFocusSlots() {
  const selectedStillExists = lastSlots.some((slot) => slot.id === selectedFocusSlotId);
  if (!selectedStillExists) selectedFocusSlotId = lastSlots[0]?.id ?? null;
  focusSlotList.replaceChildren();
  for (const slot of lastSlots) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'focus-option';
    option.dataset.slotId = slot.id;
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(slot.id === selectedFocusSlotId));

    const dot = document.createElement('i');
    dot.className = slot.crashedUntil ? 'dot crash' : slot.loggedIn ? 'dot on' : 'dot';
    option.appendChild(dot);

    const copy = document.createElement('span');
    copy.className = 'focus-option-copy';
    const name = document.createElement('span');
    name.className = 'focus-option-name';
    name.textContent = slot.name;
    const status = document.createElement('span');
    status.className = 'focus-option-status';
    status.textContent = slot.loggedIn ? 'Conta conectada' : 'Sessão em execução';
    copy.append(name, status);
    option.appendChild(copy);

    const radio = document.createElement('span');
    radio.className = 'focus-option-radio';
    radio.setAttribute('aria-hidden', 'true');
    option.appendChild(radio);
    option.addEventListener('click', () => selectFocusSlot(slot.id));
    focusSlotList.appendChild(option);
  }
  focusEnterBtn.disabled = !selectedFocusSlotId;
}

function openFocusChooser() {
  focusError.textContent = '';
  selectedFocusSlotId = lastSlots[0]?.id ?? null;
  renderFocusSlots();
  focusModal.hidden = false;
  window.launcher.setViewsVisible(false);
  focusCancelBtn.focus();
}

function closeFocusChooser(returnFocus = true) {
  if (focusModal.hidden) return;
  focusModal.hidden = true;
  window.launcher.setViewsVisible(true);
  if (returnFocus) focusBtn.focus();
}

async function enterFocusMode() {
  if (!selectedFocusSlotId) return;
  focusError.textContent = '';
  focusEnterBtn.disabled = true;
  const id = selectedFocusSlotId;
  let result;
  try {
    result = await window.launcher.setFocusedSlot(id);
  } catch {
    result = null;
  }
  if (!result?.ok) {
    focusError.textContent = result?.error === 'sessao inexistente'
      ? 'Essa sessão foi fechada. Escolha outra.'
      : 'Não foi possível ativar o modo foco.';
    focusEnterBtn.disabled = false;
    return;
  }
  focusedSlotId = id;
  syncFocusButton();
  closeFocusChooser(false);
  window.launcher.focusSlot(id);
}

async function exitFocusMode() {
  const result = await window.launcher.setFocusedSlot(null).catch(() => null);
  if (!result?.ok) return;
  focusedSlotId = null;
  syncFocusButton();
  focusBtn.focus();
}

focusBtn.addEventListener('click', () => {
  if (focusedSlotId) exitFocusMode();
  else openFocusChooser();
});
focusCancelBtn.addEventListener('click', () => closeFocusChooser());
focusEnterBtn.addEventListener('click', enterFocusMode);
focusModal.addEventListener('click', (event) => {
  if (event.target === focusModal) closeFocusChooser();
});
focusSlotList.addEventListener('keydown', (event) => {
  const options = [...focusSlotList.querySelectorAll('.focus-option')];
  if (!options.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = options.findIndex((option) => option.dataset.slotId === selectedFocusSlotId);
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? options.length - 1
      : (Math.max(current, 0) + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
  const id = options[next].dataset.slotId;
  selectFocusSlot(id);
  options[next].focus();
});
syncFocusButton();

const chipViews = new Map();
const autoStateLabel = {
  starting: 'iniciando',
  clicking: 'lançando',
  paused: 'pausado',
  'waiting-button': 'sem alvo na cena',
  'rate-limited': 'no limite por minuto',
  'economy-mode': 'Modo Economia (o jogo farma sozinho)',
  'exiting-economy': 'saindo do Modo Economia',
  'session-taken': 'sessão tomada em outra aba/dispositivo',
  captured: 'parou: capturou',
  error: 'erro',
};

function autoTitle(s) {
  const enabled = s.automation?.enabled === true;
  if (!enabled && s.autoState === 'captured') return 'Parou ao capturar — clique para reativar';
  if (!enabled) return 'Configurar automacao de lancamentos';
  const parts = [`Automacao ativa (${s.automation.mode})`, autoStateLabel[s.autoState] ?? 'iniciando', `${s.autoThrows ?? 0} lancamentos`];
  const age = s.autoLastTick ? Math.round((Date.now() - s.autoLastTick) / 1000) : null;
  if (age !== null && age > 20) parts.push(`SEM TICKS ha ${age}s`);
  else if (age !== null) parts.push(`ultimo tick ha ${age}s`);
  return parts.join(' - ');
}

function createChip() {
  const chip = document.createElement('span');
  chip.className = 'chip';
  const dot = document.createElement('i');
  dot.className = 'dot';
  chip.appendChild(dot);
  const copy = document.createElement('span');
  copy.className = 'chip-copy';
  const label = document.createElement('span');
  label.className = 'chip-name';
  label.setAttribute('role', 'button');
  label.tabIndex = 0;
  const status = document.createElement('span');
  status.className = 'chip-status';
  copy.append(label, status);
  chip.appendChild(copy);
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.hidden = true;
  chip.appendChild(tag);
  const light = document.createElement('button');
  light.type = 'button';
  light.textContent = 'LEVE';
  chip.appendChild(light);
  const auto = document.createElement('button');
  auto.type = 'button';
  auto.textContent = 'AUTO';
  chip.appendChild(auto);
  const p2 = document.createElement('button');
  p2.type = 'button';
  p2.textContent = 'P2';
  chip.appendChild(p2);
  const x = document.createElement('span');
  x.className = 'x';
  x.textContent = '×';
  x.title = 'Fechar sessao';
  x.setAttribute('role', 'button');
  x.tabIndex = 0;
  chip.appendChild(x);
  const view = { chip, dot, copy, label, status, tag, light, auto, p2, slot: null, rename: null, lightError: false, lightNote: '' };
  chip.addEventListener('click', () => {
    if (!view.slot) return;
    if (focusedSlotId) {
      const id = view.slot.id;
      window.launcher.setFocusedSlot(id)
        .then((result) => { if (result?.ok) window.launcher.focusSlot(id); })
        .catch(() => {});
    } else {
      window.launcher.focusSlot(view.slot.id);
    }
  });
  chip.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (view.slot) window.launcher.slotMenu(view.slot.id);
  });
  view.rename = () => {
    if (!view.slot || label.tagName === 'INPUT') return;
    const original = view.slot.name;
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = original;
    input.maxLength = 24;
    input.spellcheck = false;
    copy.replaceChild(input, label);
    input.focus();
    input.select();
    let done = false;
    const fim = async (salvar) => {
      if (done) return;
      done = true;
      const nome = input.value.trim().slice(0, 24);
      copy.replaceChild(label, input);
      label.textContent = original;
      if (salvar && nome && nome !== original) {
        await window.launcher.renameSlot(view.slot.id, nome).catch(() => {});
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        fim(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        fim(false);
      }
    });
    for (const tipo of ['click', 'dblclick', 'mousedown']) {
      input.addEventListener(tipo, (e) => e.stopPropagation());
    }
    input.addEventListener('blur', () => fim(true));
  };
  label.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    view.rename();
  });
  label.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    chip.click();
  });
  const fechar = () => {
    if (!view.slot) return;
    const ok = window.confirm(
      `Remover a sessao "${view.slot.name}"?\n\nO login dela sai do launcher (a particao fica 14 dias na quarentena).`
    );
    if (ok) window.launcher.removeSlot(view.slot.id);
  };
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    fechar();
  });
  x.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    fechar();
  });
  light.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!view.slot) return;
    try {
      const res = await window.launcher.setLightMode(view.slot.id, !view.slot.lightMode);
      view.lightError = !(res?.ok && res?.aplicado !== false);
      if (res?.motivo === 'fallback-reload') {
        view.lightNote = 'O jogo nao tinha o botao de sair do Economia: a sessao recarregou (ultimo recurso).';
      } else if (res?.motivo === 'p2-armado') {
        view.lightNote = 'Desarme o P2 antes de ligar o modo leve: o jogo precisa ficar no Economia.';
      } else {
        view.lightNote = '';
      }
    } catch {
      view.lightError = true;
      view.lightNote = '';
    }
    if (view.slot) updateChip(view, view.slot);
  });
  auto.addEventListener('click', (e) => {
    e.stopPropagation();
    if (view.slot) openModal(view.slot);
  });
  p2.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!view.slot) return;
    openHunt(view.slot.id);
  });
  return view;
}

function updateChip(view, s) {
  view.slot = s;
  view.chip.classList.toggle('focused', s.focused === true);
  const crashIn = s.crashedUntil ? Math.max(0, Math.ceil((s.crashedUntil - Date.now()) / 1000)) : 0;
  view.dot.className = crashIn > 0 ? 'dot crash' : s.loggedIn ? 'dot on' : 'dot';
  view.dot.title = crashIn > 0
    ? `Sessao caiu 3 vezes — recarregando em ${crashIn}s`
    : s.loggedIn
      ? 'Sessao com login ativo'
      : 'Sem login';
  view.label.textContent = crashIn > 0 ? `${s.name} — caiu, voltando` : s.name;
  view.label.title = 'Duplo clique para renomear';
  view.status.textContent = crashIn > 0
    ? 'Reconectando'
    : s.focused
      ? 'Em foco'
      : s.loggedIn
        ? 'Conta conectada'
        : 'Sessão ativa';
  view.tag.hidden = s.muted !== true;
  view.tag.textContent = s.muted === true ? 'MUDO' : '';
  view.tag.title = s.muted === true ? 'Som desta sessao silenciado' : '';
  const light = s.lightMode === true;
  const failed = view.lightError || s.lightFailed === true;
  view.light.className = `light${light ? ' on' : ''}${failed ? ' error' : ''}`;
  // O estado da restauracao vem do MAIN (nao do clique): a pendencia pode ser
  // resolvida depois (quando o AUTO/rota param), e a UI nao pode continuar
  // dizendo "vai voltar" quando ja voltou.
  const restauracao = s.lightRestauracao ?? null;
  const nota = view.lightNote || (restauracao === 'adiado'
    ? 'A preferencia de Economia/Ultra do usuario volta quando a automacao ou a rota pararem.'
    : restauracao === 'falhou'
      ? 'Nao consegui religar a preferencia de Economia/Ultra do usuario.'
      : '');
  // A nota explica o PORQUE (ex.: P2 armado) — vale mais que o texto generico.
  view.light.title = nota
    ? nota
    : failed
      ? 'Modo leve nao aplicado nesta sessao (o jogo recusou a preferencia ou o rAF nao pode ser limitado). Clique para tentar de novo.'
      : light
        ? 'Modo leve ligado: cena oculta e CPU poupado; os lancamentos seguem. Se o jogo estava em Economia/Ultra, o launcher saiu pelo botao do jogo e devolve a sua preferencia no fim.'
        : 'Modo leve desligado: clique para ocultar a cena e poupar CPU sem parar os lancamentos';
  const enabled = s.automation?.enabled === true;
  const p2st = s.p2 ?? {};
  view.p2.className = `p2${p2st.armado ? ' on' : ''}`;
  view.p2.title = p2st.armado
    ? `P2 armado: ${p2st.gastas ?? 0}/${p2st.limite ?? '?'} arremessos · ${p2st.capturas ?? 0} capturas (o jogo fica no Economia)`
    : 'P2 desarmado: clique para abrir o painel de caça e armar o arremesso no Economia';
  view.auto.className = `auto${enabled ? ' on' : ''}`;
  view.auto.dataset.state = s.autoState ?? 'idle';
  const age = enabled && s.autoLastTick ? Date.now() - s.autoLastTick : null;
  view.auto.dataset.stalled = age !== null && age > 20000 ? 'true' : 'false';
  view.auto.title = autoTitle(s);
  view.chip.title = s.route?.running
    ? `Rota de captura ativa: ${s.route.state || '...'} (alvo ${Math.min((s.route.index ?? 0) + 1, s.route.total ?? 1)}/${s.route.total ?? '?'} · ${s.route.captured ?? 0} capturadas)`
    : '';
}

window.launcher.onRenameRequest(({ id }) => chipViews.get(id)?.rename?.());

window.launcher.onState((slots) => {
  lastSlots = slots;
  focusedSlotId = slots.find((slot) => slot.focused === true)?.id ?? null;
  syncFocusButton();
  syncToolbarStatus(slots);
  if (!focusModal.hidden) renderFocusSlots();
  const ids = new Set(slots.map((s) => s.id));
  for (const [id, view] of chipViews) {
    if (ids.has(id)) continue;
    view.chip.remove();
    chipViews.delete(id);
  }
  for (const el of chips.querySelectorAll('.empty-hint')) el.remove();
  if (slots.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'empty-hint';
    hint.textContent = 'Nenhuma sessão — clique em +';
    chips.appendChild(hint);
  }
  for (const s of slots) {
    let view = chipViews.get(s.id);
    if (!view) {
      view = createChip();
      chipViews.set(s.id, view);
      chips.appendChild(view.chip);
      requestAnimationFrame(() => chips.scrollTo({ left: chips.scrollWidth, behavior: 'smooth' }));
    }
    updateChip(view, s);
  }
  const anyAuto = slots.some((s) => s.automation?.enabled);
  stopAllBtn.hidden = !anyAuto;
  const popups = slots.reduce((n, s) => n + (s.popups ?? 0), 0);
  closePopupsBtn.hidden = popups === 0;
});

setInterval(() => {
  for (const view of chipViews.values()) if (view.slot) updateChip(view, view.slot);
}, 1000);

const hint = document.createElement('span');
hint.className = 'empty-hint';
hint.textContent = 'Carregando…';
chips.appendChild(hint);

const scriptsModal = document.getElementById('scripts-modal');
const scriptsBtn = document.getElementById('scripts-btn');
const scriptsList = document.getElementById('scripts-list');
const scriptsWarn = document.getElementById('scripts-warn');
const scriptName = document.getElementById('script-name');
const scriptMode = document.getElementById('script-mode');
const scriptSlots = document.getElementById('script-slots');
const scriptEnabled = document.getElementById('script-enabled');
const scriptCode = document.getElementById('script-code');
const scriptError = document.getElementById('script-error');
const scriptSave = document.getElementById('script-save');
const scriptNew = document.getElementById('script-new');
const scriptRunNow = document.getElementById('script-run-now');
const scriptsClose = document.getElementById('scripts-close');
let allScripts = [];
let scriptWarnings = [];
let editingScriptId = null;

function scopeLabel(script) {
  if (script.scope?.mode === 'slots') {
    const n = Array.isArray(script.scope.slotIds) ? script.scope.slotIds.length : 0;
    return n === 1 ? '1 sessão' : `${n} sessões`;
  }
  return 'Todas as sessões';
}

function showScriptMsg(msg, isError) {
  scriptError.textContent = msg;
  scriptError.title = msg;
  scriptError.style.color = isError ? '#ff6b6b' : '#3fbf7f';
}

function renderScriptSlots(selected) {
  const ids = Array.isArray(selected) ? selected : [];
  scriptSlots.textContent = '';
  if (!lastSlots.length) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = 'Nenhuma sessão aberta.';
    scriptSlots.appendChild(span);
    return;
  }
  for (const s of lastSlots) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = s.id;
    cb.checked = ids.includes(s.id);
    const span = document.createElement('span');
    span.textContent = s.name;
    label.appendChild(cb);
    label.appendChild(span);
    scriptSlots.appendChild(label);
  }
}

function renderScriptsList() {
  scriptsList.textContent = '';
  for (const script of allScripts) {
    const row = document.createElement('div');
    row.className = 'script-row';
    const info = document.createElement('div');
    info.className = 'script-info';
    const name = document.createElement('div');
    name.className = 'script-name';
    name.textContent = `${script.enabled ? '' : '(off) '}${script.name}`;
    const scope = document.createElement('div');
    scope.className = 'script-scope';
    scope.textContent = scopeLabel(script);
    info.appendChild(name);
    info.appendChild(scope);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Editar';
    edit.addEventListener('click', () => startEditScript(script.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = 'Excluir';
    del.addEventListener('click', () => deleteScript(script));
    row.appendChild(info);
    row.appendChild(edit);
    row.appendChild(del);
    scriptsList.appendChild(row);
  }
}

function renderScriptWarnings() {
  scriptsWarn.hidden = scriptWarnings.length === 0;
  scriptsWarn.textContent = scriptWarnings.length ? `Avisos ao carregar: ${scriptWarnings.join('; ')}` : '';
}

function resetScriptForm() {
  editingScriptId = null;
  scriptName.value = '';
  scriptMode.value = 'all';
  scriptEnabled.checked = true;
  scriptCode.value = '';
  scriptSlots.hidden = true;
  showScriptMsg('', false);
  renderScriptSlots([]);
}

function startEditScript(id) {
  const script = allScripts.find((s) => s.id === id);
  if (!script) return;
  editingScriptId = id;
  scriptName.value = script.name;
  scriptMode.value = script.scope?.mode === 'slots' ? 'slots' : 'all';
  scriptEnabled.checked = script.enabled === true;
  scriptCode.value = script.code ?? '';
  scriptSlots.hidden = scriptMode.value !== 'slots';
  showScriptMsg('', false);
  renderScriptSlots(script.scope?.slotIds ?? []);
  scriptName.focus();
}

function closeScriptsModal() {
  scriptsModal.hidden = true;
  window.launcher.setViewsVisible(true);
  scriptsBtn.focus();
}

async function refreshScripts() {
  try {
    const res = await window.launcher.scripts();
    allScripts = Array.isArray(res) ? res : (res?.scripts ?? []);
    scriptWarnings = Array.isArray(res?.warnings) ? res.warnings : [];
  } catch (err) {
    allScripts = [];
    scriptWarnings = [];
    showScriptMsg(err?.message ?? 'Falha ao carregar scripts', true);
    throw err;
  }
  renderScriptsList();
  renderScriptWarnings();
}

async function openScriptsModal() {
  scriptsModal.hidden = false;
  window.launcher.setViewsVisible(false);
  resetScriptForm();
  try {
    await refreshScripts();
  } catch {
    /* a mensagem ja foi exibida no formulario */
  }
  scriptName.focus();
}

async function deleteScript(script) {
  if (!window.confirm(`Excluir o script "${script.name}"?`)) return;
  try {
    const res = await window.launcher.deleteScript(script.id);
    if (!res?.ok) {
      showScriptMsg(res?.error || 'Falha ao excluir', true);
      return;
    }
    if (editingScriptId === script.id) resetScriptForm();
    await refreshScripts();
  } catch (err) {
    showScriptMsg(err?.message ?? 'Falha ao excluir', true);
  }
}

scriptMode.addEventListener('change', () => {
  scriptSlots.hidden = scriptMode.value !== 'slots';
});

scriptNew.addEventListener('click', () => resetScriptForm());
scriptsBtn.addEventListener('click', openScriptsModal);
scriptsClose.addEventListener('click', closeScriptsModal);
scriptsModal.addEventListener('click', (e) => {
  if (e.target === scriptsModal) closeScriptsModal();
});

scriptSave.addEventListener('click', async () => {
  const name = scriptName.value.trim();
  if (!name) {
    showScriptMsg('Dê um nome ao script', true);
    return;
  }
  const mode = scriptMode.value === 'slots' ? 'slots' : 'all';
  const slotIds = mode === 'slots'
    ? Array.from(scriptSlots.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value)
    : [];
  if (mode === 'slots' && slotIds.length === 0) {
    showScriptMsg('Selecione ao menos uma sessão', true);
    return;
  }
  scriptSave.disabled = true;
  try {
    const res = await window.launcher.saveScript({
      id: editingScriptId ?? '',
      name,
      code: scriptCode.value,
      enabled: scriptEnabled.checked,
      scope: { mode, slotIds },
    });
    if (!res?.ok) {
      showScriptMsg(res?.error || 'Falha ao salvar', true);
      return;
    }
    await refreshScripts();
    resetScriptForm();
    showScriptMsg('Script salvo.', false);
  } catch (err) {
    showScriptMsg(err?.message ?? 'Falha ao salvar', true);
  } finally {
    scriptSave.disabled = false;
  }
});

scriptRunNow.addEventListener('click', async () => {
  scriptRunNow.disabled = true;
  try {
    const res = await window.launcher.runScripts();
    if (res?.ok) {
      if (!res.executions && !res.failures) {
        showScriptMsg('Nenhum script ativo se aplica às sessões abertas.', false);
      } else {
        const parts = [`${res.executions ?? 0} execução(ões) em ${res.sessions ?? 0} sessão(ões)`];
        if (res.failures) parts.push(`${res.failures} falha(s)`);
        showScriptMsg(parts.join(' — '), res.failures > 0);
      }
    } else {
      showScriptMsg(res?.error || 'Falha ao rodar', true);
    }
  } catch (err) {
    showScriptMsg(err?.message ?? 'Falha ao rodar', true);
  } finally {
    scriptRunNow.disabled = false;
  }
});

// ---- Painel de caça (Fase 9) ----
const huntBtn = document.getElementById('hunt-btn');
const huntModal = document.getElementById('hunt-modal');
const huntSlotSel = document.getElementById('hunt-slot');
const huntEnable = document.getElementById('hunt-enable');
const huntLevelcap = document.getElementById('hunt-levelcap');
const huntLevelcapNv = document.getElementById('hunt-levelcap-nv');
const huntRefresh = document.getElementById('hunt-refresh');
const huntClose = document.getElementById('hunt-close');
const huntInfo = document.getElementById('hunt-info');
const huntStatus = document.getElementById('hunt-status');
const huntError = document.getElementById('hunt-error');
const huntBody = document.getElementById('hunt-body');
const huntArea = document.getElementById('hunt-area');
const huntMissing = document.getElementById('hunt-missing');
const huntMissingCount = document.getElementById('hunt-missing-count');
const huntAreaList = document.getElementById('hunt-area-list');
const huntProgress = document.getElementById('hunt-progress');
const routeRisk = document.getElementById('route-risk');
const routeAck = document.getElementById('route-ack');
const routeOrdem = document.getElementById('route-ordem');
const routeMax = document.getElementById('route-max');
const routeVip = document.getElementById('route-vip');
const routeStatus = document.getElementById('route-status');
const routeMsg = document.getElementById('route-msg');
const routeStart = document.getElementById('route-start');
const routeStop = document.getElementById('route-stop');
const p2Risk = document.getElementById('p2-risk');
const p2Ack = document.getElementById('p2-ack');
const p2Max = document.getElementById('p2-max');
const p2Status = document.getElementById('p2-status');
const p2Msg = document.getElementById('p2-msg');
const p2Start = document.getElementById('p2-start');
const p2Stop = document.getElementById('p2-stop');
let huntTimer = null;
let huntBusy = false;
let cachedRouteRisk = '';
let cachedP2Risk = '';
let routeWasRunning = false;
let lastBalls = null;
const ROUTE_STATE_LABELS = {
  partindo: 'iniciando',
  'saindo-economia': 'saindo do Modo Economia',
  'modo-economia': 'aguardando saída do Modo Economia',
  'procurando-regiao': 'procurando região',
  'abrindo-mapa': 'abrindo mapa',
  viajando: 'viajando para o local',
  'aguardando-chegada': 'aguardando confirmação de chegada',
  'aguardando-alvo': 'aguardando o alvo atual',
  'esperando-caido': 'aguardando o Pokémon aparecer',
  'aguardando-vip': 'aguardando captura do VIP',
  arremessando: 'tentando capturar',
  capturado: 'captura confirmada',
  'skip-capturado': 'já capturado; seguindo fila',
  'fila-completa': 'fila concluída',
  'alvo-nao-localizado': 'alvo não localizado; rota parada',
  'falha-chegada': 'chegada não confirmada; rota parada',
  'limite-arremessos': 'limite de arremessos atingido; rota parada',
  'sem-bolas': 'sem bolas; rota parada',
  desligada: 'rota desligada',
  parado: 'rota parada',
  erro: 'erro na rota; tentando novamente',
};

function bolasTotais(balls) {
  if (!balls || typeof balls !== 'object') return null;
  const v = Object.values(balls).reduce((s, n) => s + (Number(n) || 0), 0);
  return v;
}

function showRouteMsg(msg, isError) {
  routeMsg.hidden = !msg;
  routeMsg.textContent = msg;
  routeMsg.className = msg ? `msg ${isError ? 'err' : 'ok'}` : 'msg';
}

function renderRouteStatus(st) {
  const running = st?.running === true;
  routeStop.hidden = !running;
  routeStart.hidden = running;
  routeAck.disabled = running;
  routeOrdem.disabled = running;
  routeMax.disabled = running;
  routeVip.disabled = running;
  if (routeWasRunning && !running) {
    // consentimento e por execucao: a fila acabou, o proximo fogo exige ack de novo
    routeAck.checked = false;
    routeStart.disabled = true;
    routeAck.disabled = false;
  } else if (!running) {
    routeStart.disabled = !routeAck.checked;
  }
  routeWasRunning = running;
  if (!st) {
    routeStatus.hidden = true;
    return;
  }
  routeStatus.hidden = false;
  const parts = [ROUTE_STATE_LABELS[st.state] || st.state || 'parada'];
  if (st.total) {
    parts.push(`alvo ${Math.min((st.index ?? 0) + 1, st.total)}/${st.total}${st.targetNome ? ` (${st.targetNome})` : ''}`);
  }
  parts.push(`${st.captured ?? 0} capturada(s)`);
  if (st.manualCapture) parts.push('VIP: captura pelo jogo');
  else parts.push(`${st.throws ?? 0} arremesso(s)`);
  // o balls VIVO vem da rota (pagina le o titulo da bola no DOM); o espelho do
  // welcome congela porque o jogo nao manda balls nos deltas — usar so como fallback
  if (!st.manualCapture) {
    const bolas = Number.isFinite(st.balls) ? st.balls : bolasTotais(lastBalls);
    if (bolas !== null && bolas !== undefined) parts.push(`${bolas} bolas`);
  }
  routeStatus.textContent = `Rota: ${parts.join(' · ')}`;
}

function fillHuntSlots() {
  const prev = huntSlotSel.value;
  huntSlotSel.textContent = '';
  if (!lastSlots.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Nenhuma sessão aberta';
    huntSlotSel.appendChild(opt);
    return '';
  }
  for (const s of lastSlots) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name || s.id;
    huntSlotSel.appendChild(opt);
  }
  if (prev && lastSlots.some((s) => s.id === prev)) huntSlotSel.value = prev;
  return huntSlotSel.value;
}

function huntRow(text, meta, cls) {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  const name = document.createElement('span');
  name.className = 'h-nome';
  name.textContent = text;
  li.appendChild(name);
  if (meta) {
    const m = document.createElement('span');
    m.className = 'h-meta';
    m.textContent = meta;
    li.appendChild(m);
  }
  return li;
}

let p2EstavaArmado = false;
function renderP2Status(st) {
  const armado = st?.armado === true;
  // Desarmou por qualquer caminho (chip, "Parar tudo", bandeja, rollback): o
  // aceite do risco era daquela execucao e nao vale para a proxima.
  if (p2EstavaArmado && !armado) {
    p2Ack.checked = false;
    p2Start.disabled = true;
  }
  p2EstavaArmado = armado;
  p2Start.hidden = armado;
  p2Stop.hidden = !armado;
  p2Ack.disabled = armado;
  p2Start.disabled = armado || !p2Ack.checked;
  if (!armado) {
    p2Status.hidden = true;
    p2Status.textContent = '';
    return;
  }
  const partes = [`P2 armado: ${st.gastas ?? 0}/${st.limite ?? '?'} arremessos`, `${st.capturas ?? 0} capturas`];
  if (st.pendente) partes.push('aguardando confirmação do servidor');
  p2Status.hidden = false;
  p2Status.textContent = partes.join(' · ');
}

function renderHunt(res) {
  const slot = lastSlots.find((s) => s.id === huntSlotSel.value);
  renderP2Status(res?.p2 ?? null);
  huntInfo.textContent = slot ? `${slot.name} · ${slot.url}` : '';
  if (!res || !res.ok) {
    huntStatus.hidden = true;
    huntError.hidden = false;
    huntError.textContent = (res && res.error) || 'Sem resposta do painel.';
    huntBody.hidden = true;
    huntLevelcap.disabled = true;
    return;
  }
  if (!res.enabled) {
    huntEnable.checked = false;
    huntBody.hidden = true;
    huntLevelcap.disabled = true;
    huntError.hidden = true;
    huntStatus.hidden = false;
    huntStatus.textContent =
      'Ative “Ler a dex desta sessão” para o launcher observar (só ler) o tráfego do jogo. Nada é enviado e a dex não é salva em disco.';
    return;
  }
  if (!res.ready) {
    huntEnable.checked = true;
    huntBody.hidden = true;
    huntLevelcap.disabled = true;
    huntError.hidden = true;
    huntStatus.hidden = false;
    huntStatus.textContent = 'Leitura ligada; recarreguei a aba. Os dados chegam quando o jogo conectar nesta conta.';
    return;
  }
  huntEnable.checked = true;
  huntStatus.hidden = true;
  huntError.hidden = true;
  huntBody.hidden = false;
  huntLevelcap.disabled = !res.trainerLevel;
  huntLevelcapNv.textContent = res.trainerLevel ? `(≤ ${res.trainerLevel})` : '';
  const view = res.view;
  lastBalls = view.balls ?? null;
  renderRouteStatus((slot || {}).route);
  huntArea.textContent = view.current
    ? `Área atual: ${view.current.nome} · nível ${view.current.nivel} (${view.current.area})`
    : 'Sem área de caça reconhecida nesta sessão.';
  huntMissing.textContent = '';
  const miss = res.missing || { total: 0, items: [] };
  huntMissingCount.textContent = miss.total
    ? `· ${miss.total}${miss.cortadosPorNivel ? ` (${miss.cortadosPorNivel} acima do seu nível)` : ''}`
    : '';
  for (const item of miss.items) {
    const meta = `nv ${item.nivel}${item.tentativas ? ` · ${item.tentativas} derrotas` : ''}`;
    huntMissing.appendChild(huntRow(item.nome, meta, null));
  }
  huntAreaList.textContent = '';
  for (const item of view.faltam) huntAreaList.appendChild(huntRow(item.nome, `faltam · ${item.k} tentativas`, 'catch'));
  for (const item of view.tem) huntAreaList.appendChild(huntRow(item.nome, `capturado (${item.c})`, null));
  huntProgress.textContent = `Sua dex: ${view.progress.captured} capturadas · catálogo do jogo: ${view.progress.catalogSize} espécies.`;
}

async function loadHunt() {
  if (huntBusy) return;
  huntBusy = true;
  try {
    const id = fillHuntSlots();
    if (!id) {
      huntStatus.hidden = false;
      huntStatus.textContent = 'Abra uma sessão primeiro.';
      huntError.hidden = true;
      huntBody.hidden = true;
      return;
    }
    renderHunt(await window.launcher.hunt(id, { levelCap: huntLevelcap.checked }));
  } catch (err) {
    huntStatus.hidden = false;
    huntStatus.textContent = err?.message || 'Falha ao ler o painel.';
    huntError.hidden = true;
    huntBody.hidden = true;
  } finally {
    huntBusy = false;
  }
}

function openHunt(preferId) {
  huntModal.hidden = false;
  window.launcher.setViewsVisible(false);
  loadRouteRisk();
  loadP2Risk();
  fillHuntSlots();
  if (preferId) huntSlotSel.value = preferId;
  loadHunt();
  huntTimer = setInterval(loadHunt, 2500);
  huntSlotSel.focus();
}

function closeHunt() {
  huntModal.hidden = true;
  if (huntTimer) {
    clearInterval(huntTimer);
    huntTimer = null;
  }
  window.launcher.setViewsVisible(true);
  huntBtn.focus();
}

huntBtn.addEventListener('click', openHunt);
huntClose.addEventListener('click', closeHunt);
huntRefresh.addEventListener('click', loadHunt);
huntSlotSel.addEventListener('change', () => {
  // O aceite do risco e POR SESSAO: marcar na conta A e trocar para a conta B
  // nao pode levar o consentimento junto.
  p2Ack.checked = false;
  p2Start.disabled = true;
  loadHunt();
});
huntLevelcap.addEventListener('change', loadHunt);
huntModal.addEventListener('click', (e) => {
  if (e.target === huntModal) closeHunt();
});
huntEnable.addEventListener('change', async () => {
  const id = huntSlotSel.value;
  if (!id) return;
  huntEnable.disabled = true;
  try {
    const res = await window.launcher.dexSet(id, huntEnable.checked);
    if (!res?.ok) {
      huntEnable.checked = !huntEnable.checked;
      huntStatus.hidden = false;
      huntStatus.textContent = res?.error || 'Não foi possível ligar/desligar agora.';
    }
  } catch (err) {
    huntEnable.checked = !huntEnable.checked;
    huntStatus.hidden = false;
    huntStatus.textContent = err?.message || 'Falha ao alternar a leitura.';
  } finally {
    huntEnable.disabled = false;
    loadHunt();
  }
});

routeAck.addEventListener('change', () => {
  routeStart.disabled = !routeAck.checked;
  if (routeAck.checked) showRouteMsg('', false);
});

routeStart.addEventListener('click', async () => {
  const id = huntSlotSel.value;
  if (!id) return;
  routeStart.disabled = true;
  try {
    const res = await window.launcher.routeSet({
      id,
      on: true,
      ackRisk: routeAck.checked,
      ordem: routeOrdem.value,
      maxAlvos: Number(routeMax.value) || 3,
      levelCap: huntLevelcap.checked,
      manualCapture: routeVip.checked,
    });
    if (!res?.ok) {
      showRouteMsg(res?.error || 'Não foi possível ligar a rota.', true);
      routeStart.disabled = !routeAck.checked;
    } else {
      showRouteMsg('', false);
    }
    loadHunt();
  } catch (err) {
    showRouteMsg(err?.message || 'Falha ao ligar a rota.', true);
    routeStart.disabled = !routeAck.checked;
  }
});

routeStop.addEventListener('click', async () => {
  const id = huntSlotSel.value;
  if (!id) return;
  routeStop.disabled = true;
  try {
    await window.launcher.routeSet({ id, on: false });
  } catch {
    /* o proximo poll mostra o estado real */
  } finally {
    routeStop.disabled = false;
    loadHunt();
  }
});

async function loadRouteRisk() {
  if (cachedRouteRisk) {
    routeRisk.textContent = cachedRouteRisk;
    return;
  }
  try {
    cachedRouteRisk = (await window.launcher.routeRisk()) || '';
    routeRisk.textContent = cachedRouteRisk;
  } catch {
    routeRisk.textContent = 'Automatizar viola os Termos de Uso; o risco da rota é da sua conta.';
  }
}

async function loadP2Risk() {
  if (cachedP2Risk) {
    p2Risk.textContent = cachedP2Risk;
    return;
  }
  try {
    cachedP2Risk = (await window.launcher.p2Risk()) || '';
    p2Risk.textContent = cachedP2Risk;
  } catch {
    p2Risk.textContent = 'O P2 escreve no socket do jogo; automatizar viola os Termos de Uso.';
  }
}

function showP2Msg(msg, isError) {
  p2Msg.hidden = !msg;
  p2Msg.textContent = msg || '';
  p2Msg.className = isError ? 'msg error' : 'msg';
}

p2Ack.addEventListener('change', () => {
  p2Start.disabled = !p2Ack.checked || p2Stop.hidden === false;
  if (p2Ack.checked) showP2Msg('', false);
});

p2Start.addEventListener('click', async () => {
  const id = huntSlotSel.value;
  if (!id) return;
  p2Start.disabled = true;
  try {
    const maxBolas = Number(p2Max?.value);
    const res = await window.launcher.p2Set({
      id,
      on: true,
      ackRisk: p2Ack.checked,
      maxBolas: Number.isFinite(maxBolas) && maxBolas > 0 ? Math.floor(maxBolas) : 30,
    });
    if (!res?.ok) {
      showP2Msg(res?.error || 'Não foi possível armar o P2.', true);
      p2Start.disabled = !p2Ack.checked;
    } else {
      showP2Msg('', false);
    }
    loadHunt();
  } catch (err) {
    showP2Msg(err?.message || 'Falha ao armar o P2.', true);
    p2Start.disabled = !p2Ack.checked;
  }
});

p2Stop.addEventListener('click', async () => {
  const id = huntSlotSel.value;
  if (!id) return;
  p2Stop.disabled = true;
  try {
    await window.launcher.p2Set({ id, on: false });
    // Consentimento e POR EXECUCAO: desarmou, o aviso de risco volta a valer
    // (armar de novo exige marcar a caixa e ler o texto).
    p2Ack.checked = false;
    p2Start.disabled = true;
    showP2Msg('', false);
  } catch {
    /* o proximo poll mostra o estado real */
  } finally {
    p2Stop.disabled = false;
    loadHunt();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !huntModal.hidden) closeHunt();
});
