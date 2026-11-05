const chips = document.getElementById('chips');
const form = document.getElementById('add-form');
const addBtn = document.getElementById('add');
const nameInput = document.getElementById('add-name');
const urlInput = document.getElementById('add-url');

addBtn.addEventListener('click', () => {
  form.hidden = false;
  addBtn.hidden = true;
  nameInput.focus();
});
document.getElementById('add-cancel').addEventListener('click', closeForm);
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await window.launcher.addSlot(nameInput.value.trim(), urlInput.value.trim());
  } catch (err) {
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
    document.querySelectorAll('#layout-btns button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    window.launcher.setLayout(Number(btn.dataset.cols));
  });
});

window.launcher.onState((slots) => {
  chips.replaceChildren();
  if (slots.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'empty-hint';
    hint.textContent = 'Nenhuma sessão — clique em +';
    chips.appendChild(hint);
  }
  for (const s of slots) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = s.name;
    chip.addEventListener('click', () => window.launcher.focusSlot(s.id));
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Fechar sessão';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      window.launcher.removeSlot(s.id);
    });
    chip.appendChild(x);
    chips.appendChild(chip);
  }
});

const hint = document.createElement('span');
hint.className = 'empty-hint';
hint.textContent = 'Carregando…';
chips.appendChild(hint);
