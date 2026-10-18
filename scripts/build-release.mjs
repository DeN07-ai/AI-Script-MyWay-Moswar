import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// ─── Пути и конфигурация ──────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Корень проекта: по умолчанию родительская папка для scripts/ (папка AI-Script),
// либо путь из переменной окружения AI_SCRIPT_ROOT (для изолированных тестов).
export const projectRoot = process.env.AI_SCRIPT_ROOT
  ? path.resolve(process.env.AI_SCRIPT_ROOT)
  : path.resolve(__dirname, '..');

export const MAIN_SCRIPT_NAME = 'AI MyWay DeN.user.js';
export const BRIDGE_SCRIPT_NAME = 'MoswarBot by MY WAY DEN .user.js';
export const HISTORICAL_SCRIPT_NAME = 'AI MyWay DeN.js';

export const EXPECTED_CONFIG = {
  main: {
    name: 'AI MyWay DeN',
    namespace: 'MyWay.Moswar',
    updateURL:
      'https://github.com/DeN07-ai/AI-Script-MyWay-Moswar/raw/refs/heads/main/AI%20MyWay%20DeN.user.js',
    downloadURL:
      'https://github.com/DeN07-ai/AI-Script-MyWay-Moswar/raw/refs/heads/main/AI%20MyWay%20DeN.user.js',
  },
  bridge: {
    name: 'MoswarBot by MY WAY DEN',
    namespace: 'MY WAY',
    updateURL:
      'https://github.com/DeN07-ai/AI-Script-MyWay-Moswar/raw/refs/heads/main/MoswarBot%20by%20MY%20WAY%20DEN%20.user.js',
    downloadURL:
      'https://github.com/DeN07-ai/AI-Script-MyWay-Moswar/raw/refs/heads/main/MoswarBot%20by%20MY%20WAY%20DEN%20.user.js',
  },
};

export const SINGLETON_DIRECTIVES = new Set([
  'name',
  'namespace',
  'version',
  'description',
  'author',
  'updateURL',
  'downloadURL',
  'noframes',
]);

export function getBackupDir(customRoot = projectRoot) {
  if (process.env.AI_SCRIPT_BACKUP_DIR) {
    return path.resolve(process.env.AI_SCRIPT_BACKUP_DIR);
  }
  if (customRoot && path.resolve(customRoot) !== path.resolve(projectRoot)) {
    return path.join(path.resolve(customRoot), 'backups');
  }
  return path.join(
    os.homedir(),
    'Мосвар',
    'локальные рабочие файлы',
    'Резервные копии'
  );
}

// ─── Разбор и валидация userscript ───────────────────────────────────────────

export function parseUserscript(content, filename = 'script.user.js') {
  const startMarker = '// ==UserScript==';
  const endMarker = '// ==/UserScript==';

  const startIndex = content.indexOf(startMarker);
  if (startIndex === -1) {
    throw new Error(
      `В файле "${filename}" отсутствует открывающий заголовок userscript: "${startMarker}".`
    );
  }

  const endIndex = content.indexOf(endMarker, startIndex);
  if (endIndex === -1) {
    throw new Error(
      `В файле "${filename}" отсутствует закрывающий маркер userscript: "${endMarker}".`
    );
  }

  const headerEnd = endIndex + endMarker.length;
  const rawHeader = content.slice(0, headerEnd);
  const body = content.slice(headerEnd);

  const lines = rawHeader.split(/\r?\n/);
  const directives = new Map(); // key -> Array of { value, lineIndex, rawLine }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\/\/\s*@([a-zA-Z0-9_-]+)(?:\s+(.*))?$/);
    if (match) {
      const key = match[1];
      const val = match[2] !== undefined ? match[2].trim() : '';
      if (!directives.has(key)) {
        directives.set(key, []);
      }
      directives.get(key).push({ value: val, lineIndex: i, rawLine: line });
    }
  }

  return {
    rawHeader,
    body,
    directives,
    headerEnd,
  };
}

export function validateSingleDirective(directives, key, filename) {
  const entries = directives.get(key) || [];
  if (entries.length === 0) {
    throw new Error(
      `В файле "${filename}" отсутствует обязательная директива @${key}.`
    );
  }
  if (entries.length > 1) {
    throw new Error(
      `В файле "${filename}" обнаружено дублирование директивы @${key} (встречается ${entries.length} раз). Ожидается ровно одна директива.`
    );
  }
  return entries[0].value;
}

export function validateVersionFormat(version, filename = '') {
  if (!version || typeof version !== 'string') {
    throw new Error(
      `В файле "${filename}" пустая или некорректная версия.`
    );
  }
  const trimmed = version.trim();
  // Поддерживаем форматы версий проекта: 3.8, 3.10, 2.4.7
  if (!/^\d+(\.\d+)+$/.test(trimmed)) {
    throw new Error(
      `Недопустимый формат версии "${version}" в "${filename}". Ожидается числовой формат вида X.Y или X.Y.Z (например, 3.8, 3.9, 3.10).`
    );
  }
  return trimmed;
}

export function compareVersions(v1, v2) {
  const parts1 = v1.trim().split('.').map(p => parseInt(p, 10));
  const parts2 = v2.trim().split('.').map(p => parseInt(p, 10));
  const len = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < len; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

export function bumpVersion(currentVersion) {
  validateVersionFormat(currentVersion, 'bumpVersion');
  const parts = currentVersion.trim().split('.').map(p => parseInt(p, 10));
  // Инкрементируем последний числовой компонент
  parts[parts.length - 1] += 1;
  return parts.join('.');
}

// ─── Валидация метаданных ───────────────────────────────────────────────────

export function validateMetadata(parsed, role = 'main', filename = '') {
  const { directives } = parsed;

  for (const dir of SINGLETON_DIRECTIVES) {
    const list = directives.get(dir);
    if (list && list.length > 1) {
      throw new Error(
        `В файле "${filename}" дублируется директива @${dir} (${list.length} раз). Разрешена только 1 директива.`
      );
    }
  }

  const name = validateSingleDirective(directives, 'name', filename);
  const namespace = validateSingleDirective(directives, 'namespace', filename);
  const version = validateSingleDirective(directives, 'version', filename);
  validateVersionFormat(version, filename);
  const updateURL = validateSingleDirective(directives, 'updateURL', filename);
  const downloadURL = validateSingleDirective(directives, 'downloadURL', filename);
  validateSingleDirective(directives, 'description', filename);

  const expected = EXPECTED_CONFIG[role];
  if (expected) {
    if (name !== expected.name) {
      throw new Error(
        `В "${filename}" значение @name ("${name}") не соответствует ожидаемому ("${expected.name}").`
      );
    }
    if (namespace !== expected.namespace) {
      throw new Error(
        `В "${filename}" значение @namespace ("${namespace}") не соответствует ожидаемому ("${expected.namespace}").`
      );
    }
    if (updateURL !== expected.updateURL) {
      throw new Error(
        `В "${filename}" значение @updateURL не совпадает с ожидаемым.\nТекущее:  ${updateURL}\nОжидается: ${expected.updateURL}`
      );
    }
    if (downloadURL !== expected.downloadURL) {
      throw new Error(
        `В "${filename}" значение @downloadURL не совпадает с ожидаемым.\nТекущее:  ${downloadURL}\nОжидается: ${expected.downloadURL}`
      );
    }
  }

  return { name, namespace, version, updateURL, downloadURL };
}

// ─── Генерация моста совместимости ──────────────────────────────────────────

export function generateBridgeContent(mainParsed, targetVersion = null) {
  const version = targetVersion || validateSingleDirective(mainParsed.directives, 'version', MAIN_SCRIPT_NAME);
  validateVersionFormat(version, 'generateBridgeContent');

  // Заменяем директивы в заголовке
  let header = mainParsed.rawHeader;

  function replaceDirective(text, key, val) {
    const re = new RegExp(`^//\\s*@${key}(?:\\s+.*)?$`, 'm');
    const spaces = ' '.repeat(Math.max(1, 13 - key.length));
    const newLine = `// @${key}${spaces}${val}`;
    if (!re.test(text)) {
      throw new Error(`Не удалось найти директиву @${key} в заголовке для замены.`);
    }
    return text.replace(re, newLine);
  }

  header = replaceDirective(header, 'name', EXPECTED_CONFIG.bridge.name);
  header = replaceDirective(header, 'namespace', EXPECTED_CONFIG.bridge.namespace);
  header = replaceDirective(header, 'version', version);
  header = replaceDirective(header, 'updateURL', EXPECTED_CONFIG.bridge.updateURL);
  header = replaceDirective(header, 'downloadURL', EXPECTED_CONFIG.bridge.downloadURL);

  const generated = header + mainParsed.body;

  // Валидируем сгенерированный результат в памяти
  const checkParsed = parseUserscript(generated, BRIDGE_SCRIPT_NAME);
  const meta = validateMetadata(checkParsed, 'bridge', BRIDGE_SCRIPT_NAME);

  if (meta.version !== version) {
    throw new Error(`Ошибка генерации: версия моста (${meta.version}) не равна целевой (${version}).`);
  }
  if (!generated.endsWith(mainParsed.body)) {
    throw new Error('Ошибка генерации: тело моста не совпадает с телом основного скрипта.');
  }

  return generated;
}

export function updateMainVersion(mainContent, newVersion) {
  validateVersionFormat(newVersion, 'updateMainVersion');
  const parsed = parseUserscript(mainContent, MAIN_SCRIPT_NAME);
  const re = /^\/\/\s*@version(?:\s+.*)?$/m;
  if (!re.test(parsed.rawHeader)) {
    throw new Error('В заголовке основного скрипта не найдена директива @version.');
  }
  const newHeader = parsed.rawHeader.replace(re, `// @version      ${newVersion}`);
  const updated = newHeader + parsed.body;

  // Проверка в памяти
  const recheck = parseUserscript(updated, MAIN_SCRIPT_NAME);
  const meta = validateMetadata(recheck, 'main', MAIN_SCRIPT_NAME);
  if (meta.version !== newVersion) {
    throw new Error(`Ошибка обновления версии: получена ${meta.version}, ожидалась ${newVersion}.`);
  }
  return updated;
}

// ─── Резервное копирование ───────────────────────────────────────────────────

export function backupFile(filePath, backupDir = getBackupDir()) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  fs.mkdirSync(backupDir, { recursive: true });

  const base = path.basename(filePath);
  const cleanBase = base.replace(/[^a-zA-Z0-9._-]/g, '-');
  const now = new Date().toISOString().replace(/[:.]/g, '-');

  let backupName = `${cleanBase}-${now}.bak`;
  let backupPath = path.join(backupDir, backupName);
  let counter = 1;

  // Гарантия отсутствия перезаписи существующих бэкапов
  while (fs.existsSync(backupPath)) {
    backupName = `${cleanBase}-${now}-${counter}.bak`;
    backupPath = path.join(backupDir, backupName);
    counter++;
  }

  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

// ─── Основные операции CLI ──────────────────────────────────────────────────

export function runCheck(root = projectRoot) {
  const mainPath = path.join(root, MAIN_SCRIPT_NAME);
  const bridgePath = path.join(root, BRIDGE_SCRIPT_NAME);

  if (!fs.existsSync(mainPath)) {
    throw new Error(
      `Основной файл скрипта не найден: ${mainPath}.\nДействие: убедитесь, что запускаете сборщик из репозитория AI-Script.`
    );
  }

  const mainContent = fs.readFileSync(mainPath, 'utf8');
  const mainParsed = parseUserscript(mainContent, MAIN_SCRIPT_NAME);
  const mainMeta = validateMetadata(mainParsed, 'main', MAIN_SCRIPT_NAME);

  if (!fs.existsSync(bridgePath)) {
    throw new Error(
      `Файл совместимости (мост) отсутствует: ${bridgePath}.\nДействие: выполните обычную сборку для генерации моста:\n  node scripts/build-release.mjs`
    );
  }

  const bridgeContent = fs.readFileSync(bridgePath, 'utf8');
  const bridgeParsed = parseUserscript(bridgeContent, BRIDGE_SCRIPT_NAME);
  const bridgeMeta = validateMetadata(bridgeParsed, 'bridge', BRIDGE_SCRIPT_NAME);

  if (mainMeta.version !== bridgeMeta.version) {
    throw new Error(
      `Несовпадение версий!\nОсновной файл (${MAIN_SCRIPT_NAME}): @version ${mainMeta.version}\nФайл моста (${BRIDGE_SCRIPT_NAME}): @version ${bridgeMeta.version}\nДействие: запустите сборку моста: node scripts/build-release.mjs`
    );
  }

  if (mainParsed.body !== bridgeParsed.body) {
    throw new Error(
      `Кодовая часть (тело) моста не совпадает с основным файлом!\nДействие: выполните синхронизацию моста:\n  node scripts/build-release.mjs`
    );
  }

  // Проверяем точное соответствие эталону генерации
  const expectedBridge = generateBridgeContent(mainParsed, mainMeta.version);
  if (bridgeContent !== expectedBridge) {
    throw new Error(
      `Заголовок или структура моста отличаются от актуального генератора.\nДействие: обновите мост командой:\n  node scripts/build-release.mjs`
    );
  }

  return {
    version: mainMeta.version,
    mainMeta,
    bridgeMeta,
  };
}

export function runPreview(root = projectRoot, isRelease = false) {
  const mainPath = path.join(root, MAIN_SCRIPT_NAME);
  const bridgePath = path.join(root, BRIDGE_SCRIPT_NAME);

  if (!fs.existsSync(mainPath)) {
    throw new Error(`Основной файл не найден: ${mainPath}`);
  }

  const mainContent = fs.readFileSync(mainPath, 'utf8');
  const mainParsed = parseUserscript(mainContent, MAIN_SCRIPT_NAME);
  const mainMeta = validateMetadata(mainParsed, 'main', MAIN_SCRIPT_NAME);

  const bridgeExists = fs.existsSync(bridgePath);
  let bridgeStatus = 'отсутствует (будет создан)';
  let bridgeMatches = false;

  if (bridgeExists) {
    const bridgeContent = fs.readFileSync(bridgePath, 'utf8');
    const expectedBridge = generateBridgeContent(mainParsed, mainMeta.version);
    bridgeMatches = bridgeContent === expectedBridge;
    bridgeStatus = bridgeMatches ? 'актуален и синхронизирован' : 'требует обновления';
  }

  if (isRelease) {
    const nextVer = bumpVersion(mainMeta.version);
    return {
      mode: 'release',
      currentVersion: mainMeta.version,
      nextVersion: nextVer,
      mainFile: MAIN_SCRIPT_NAME,
      bridgeFile: BRIDGE_SCRIPT_NAME,
      bridgeStatus,
      willModifyMain: true,
      willModifyBridge: true,
    };
  }

  return {
    mode: 'build',
    currentVersion: mainMeta.version,
    mainFile: MAIN_SCRIPT_NAME,
    bridgeFile: BRIDGE_SCRIPT_NAME,
    bridgeStatus,
    bridgeExists,
    bridgeMatches,
    willModifyMain: false,
    willModifyBridge: !bridgeMatches,
  };
}

export function runBuild(root = projectRoot) {
  const mainPath = path.join(root, MAIN_SCRIPT_NAME);
  const bridgePath = path.join(root, BRIDGE_SCRIPT_NAME);

  if (!fs.existsSync(mainPath)) {
    throw new Error(`Не найден основной файл: ${mainPath}`);
  }

  const mainContent = fs.readFileSync(mainPath, 'utf8');
  const mainParsed = parseUserscript(mainContent, MAIN_SCRIPT_NAME);
  const mainMeta = validateMetadata(mainParsed, 'main', MAIN_SCRIPT_NAME);

  const generatedBridge = generateBridgeContent(mainParsed, mainMeta.version);

  // Проверяем, совпадает ли уже текущий файл моста
  if (fs.existsSync(bridgePath)) {
    const currentBridge = fs.readFileSync(bridgePath, 'utf8');
    if (currentBridge === generatedBridge) {
      return {
        updated: false,
        version: mainMeta.version,
        message: 'Файл совместимости уже актуален. Запись на диск не требуется.',
      };
    }
  }

  // Создаём резервную копию перед изменением
  let backupCreated = null;
  if (fs.existsSync(bridgePath)) {
    backupCreated = backupFile(bridgePath, getBackupDir(root));
  }

  // Записываем файл
  fs.writeFileSync(bridgePath, generatedBridge, 'utf8');

  // Повторное чтение и контрольная проверка
  const reRead = fs.readFileSync(bridgePath, 'utf8');
  if (reRead !== generatedBridge) {
    throw new Error('Критическая ошибка: прочитанное содержимое моста не совпадает со сгенерированным!');
  }

  return {
    updated: true,
    version: mainMeta.version,
    backupPath: backupCreated,
    sourceFile: MAIN_SCRIPT_NAME,
    targetFile: BRIDGE_SCRIPT_NAME,
  };
}

export async function runRelease(root = projectRoot, options = {}) {
  const { autoConfirm = false, rlInterface = null } = options;

  const mainPath = path.join(root, MAIN_SCRIPT_NAME);
  const bridgePath = path.join(root, BRIDGE_SCRIPT_NAME);

  if (!fs.existsSync(mainPath)) {
    throw new Error(`Основной файл не найден: ${mainPath}`);
  }

  const mainContent = fs.readFileSync(mainPath, 'utf8');
  const mainParsed = parseUserscript(mainContent, MAIN_SCRIPT_NAME);
  const mainMeta = validateMetadata(mainParsed, 'main', MAIN_SCRIPT_NAME);

  const currentVersion = mainMeta.version;
  const nextVersion = bumpVersion(currentVersion);

  // Подтверждение
  if (!autoConfirm) {
    let answer = '';
    if (rlInterface) {
      answer = await new Promise(resolve => {
        rlInterface.question(
          `Подготовить релиз: версия ${currentVersion} → ${nextVersion}?\nБудут обновлены: ${MAIN_SCRIPT_NAME} и ${BRIDGE_SCRIPT_NAME}.\nВведите [y/N]: `,
          resolve
        );
      });
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      answer = await new Promise(resolve => {
        rl.question(
          `Подготовить релиз: версия ${currentVersion} → ${nextVersion}?\nБудут обновлены: ${MAIN_SCRIPT_NAME} и ${BRIDGE_SCRIPT_NAME}.\nВведите [y/N]: `,
          ans => {
            rl.close();
            resolve(ans);
          }
        );
      });
    }

    const trimmed = (answer || '').trim().toLowerCase();
    if (trimmed !== 'y' && trimmed !== 'yes' && trimmed !== 'д' && trimmed !== 'да') {
      return {
        confirmed: false,
        message: 'Операция отменена пользователем. Файлы не изменялись.',
      };
    }
  }

  // Формируем изменения в памяти
  const newMainContent = updateMainVersion(mainContent, nextVersion);
  const newMainParsed = parseUserscript(newMainContent, MAIN_SCRIPT_NAME);
  const newBridgeContent = generateBridgeContent(newMainParsed, nextVersion);

  // Создаём резервные копии обоих файлов
  const backupDir = getBackupDir(root);
  const mainBackup = backupFile(mainPath, backupDir);
  let bridgeBackup = null;
  if (fs.existsSync(bridgePath)) {
    bridgeBackup = backupFile(bridgePath, backupDir);
  }

  // Записываем оба файла
  fs.writeFileSync(mainPath, newMainContent, 'utf8');
  fs.writeFileSync(bridgePath, newBridgeContent, 'utf8');

  // Повторное чтение и контрольная проверка после записи
  const verifiedMain = fs.readFileSync(mainPath, 'utf8');
  const verifiedBridge = fs.readFileSync(bridgePath, 'utf8');

  if (verifiedMain !== newMainContent) {
    throw new Error('Критическая ошибка: верификация после записи основного файла не прошла!');
  }
  if (verifiedBridge !== newBridgeContent) {
    throw new Error('Критическая ошибка: верификация после записи моста не прошла!');
  }

  // Обновляем версию в README.md, если строка версии найдена
  const readmePath = path.join(root, 'README.md');
  let readmeUpdated = false;
  if (fs.existsSync(readmePath)) {
    const readmeContent = fs.readFileSync(readmePath, 'utf8');
    const versionHeaderRe = /^(Версия:\s*\*\*)[^*]+(\*\*.*)$/m;
    if (versionHeaderRe.test(readmeContent)) {
      const updatedReadme = readmeContent.replace(
        versionHeaderRe,
        `$1${nextVersion}$2`
      );
      fs.writeFileSync(readmePath, updatedReadme, 'utf8');
      readmeUpdated = true;
    }
  }

  return {
    confirmed: true,
    oldVersion: currentVersion,
    newVersion: nextVersion,
    mainBackup,
    bridgeBackup,
    readmeUpdated,
  };
}

// ─── CLI Entrypoint ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes('--check');
  const isPreview = args.includes('--preview');
  const isRelease = args.includes('--release');
  const autoConfirm = args.includes('--yes') || args.includes('-y');

  try {
    if (isCheck) {
      const result = runCheck();
      console.log('✔ ПРОВЕРКА ПРОЙДЕНА УСПЕШНО');
      console.log(`• Версия: ${result.version}`);
      console.log(`• Основной скрипт: ${MAIN_SCRIPT_NAME}`);
      console.log(`• Мост совместимости: ${BRIDGE_SCRIPT_NAME}`);
      console.log('• Метаданные корректны, обязательные директивы в единственном числе.');
      console.log('• Кодовая часть моста полностью идентична основному файлу.');
      console.log('• Файлы не изменялись.');
      process.exit(0);
    }

    if (isPreview) {
      const preview = runPreview(projectRoot, isRelease);
      console.log('\n--- ПРЕДПРОСМОТР ОПЕРАЦИИ (файлы не изменяются) ---');
      if (preview.mode === 'release') {
        console.log(`• Режим: подготовка релиза`);
        console.log(`• Текущая версия: ${preview.currentVersion}`);
        console.log(`• Новая версия после релиза: ${preview.nextVersion}`);
        console.log(`• Будет изменён основной файл: ${preview.mainFile}`);
        console.log(`• Будет обновлён мост: ${preview.bridgeFile}`);
        console.log(`• Будут созданы резервные копии в каталоге: ${getBackupDir()}`);
      } else {
        console.log(`• Режим: обычная сборка моста`);
        console.log(`• Текущая версия: ${preview.currentVersion}`);
        console.log(`• Статус файла моста: ${preview.bridgeStatus}`);
        console.log(`• Требуется перезапись моста: ${preview.willModifyBridge ? 'ДА' : 'НЕТ'}`);
      }
      console.log('----------------------------------------------------');
      process.exit(0);
    }

    if (isRelease) {
      console.log('\n--- ПОДГОТОВКА НОВОГО РЕЛИЗА ---');
      const result = await runRelease(projectRoot, { autoConfirm });
      if (!result.confirmed) {
        console.log(`\nℹ ${result.message}`);
        process.exit(0);
      }

      console.log('\n✔ РЕЛИЗ УСПЕШНО ПОДГОТОВЛЕН');
      console.log(`• Версия повышена: ${result.oldVersion} → ${result.newVersion}`);
      console.log(`• Обновлён основной файл: ${MAIN_SCRIPT_NAME}`);
      console.log(`• Обновлён мост совместимости: ${BRIDGE_SCRIPT_NAME}`);
      if (result.readmeUpdated) {
        console.log('• Обновлена строка версии в README.md');
      }
      console.log('\nРезервные копии:');
      if (result.mainBackup) console.log(`• ${result.mainBackup}`);
      if (result.bridgeBackup) console.log(`• ${result.bridgeBackup}`);

      console.log('\nВАЖНО:');
      console.log('1. Локальная сборка НЕ публикует файлы на GitHub и НЕ делает git commit.');
      console.log('2. Проверьте изменения: git diff');
      console.log('3. Проверьте статус: git status');
      console.log('4. Публикация выполняется только пользователем вручную по правилам проекта.');
      process.exit(0);
    }

    // Обычная сборка по умолчанию
    console.log('\n--- СБОРКА МОСТА СОВМЕСТИМОСТИ ---');
    const result = runBuild();
    if (!result.updated) {
      console.log(`✔ ${result.message}`);
      console.log(`• Текущая версия: ${result.version}`);
      console.log('• Файлы не требовали перезаписи.');
    } else {
      console.log('✔ СБОРКА УСПЕШНО ЗАВЕРШЕНА');
      console.log(`• Версия: ${result.version}`);
      console.log(`• Источник: ${result.sourceFile}`);
      console.log(`• Обновлён мост: ${result.targetFile}`);
      if (result.backupPath) {
        console.log(`• Резервная копия сохранена: ${result.backupPath}`);
      }
      console.log('• Кодовая часть моста синхронизирована с основным файлом.');
      console.log('• Git commit и публикация НЕ выполнялись.');
    }
    console.log('\nДля проверки выполните: node scripts/build-release.mjs --check');
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ ОШИБКА: ${err.message}`);
    process.exit(1);
  }
}

// Запуск main только если скрипт запущен напрямую из CLI, а не импортирован тестами
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main();
}
