import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  parseUserscript,
  validateMetadata,
  validateVersionFormat,
  compareVersions,
  bumpVersion,
  generateBridgeContent,
  updateMainVersion,
  backupFile,
  runCheck,
  runPreview,
  runBuild,
  runRelease,
  MAIN_SCRIPT_NAME,
  BRIDGE_SCRIPT_NAME,
  HISTORICAL_SCRIPT_NAME,
  EXPECTED_CONFIG,
} from '../scripts/build-release.mjs';

function createFixtureWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-fixture-'));
  const backupDir = path.join(tmpDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const mainHeader = [
    '// ==UserScript==',
    '// @name         AI MyWay DeN',
    '// @namespace    MyWay.Moswar',
    '// @version      3.8',
    '// @author       MyWay DeN',
    '// @description  Модульный скрипт для moswar.ru',
    '// @match        https://*.moswar.ru/*',
    '// @grant        GM_info',
    '// @noframes',
    '// @updateURL    https://github.com/DeN07-ai/AI-Script-MyWay-Moswar/raw/refs/heads/main/AI%20MyWay%20DeN.user.js',
    '// @downloadURL  https://github.com/DeN07-ai/AI-Script-MyWay-Moswar/raw/refs/heads/main/AI%20MyWay%20DeN.user.js',
    '// ==/UserScript==',
  ].join('\n');

  const sampleBody = '\n\nconsole.log("MOSWAR_PRODUCTION_LOGIC");\n';
  const mainContent = mainHeader + sampleBody;

  fs.writeFileSync(path.join(tmpDir, MAIN_SCRIPT_NAME), mainContent, 'utf8');

  // Создаем файл исторической копии, чтобы проверить, что он никогда не затрагивается
  const historicalContent = '// Historical frozen copy\nconsole.log("HISTORICAL_V1");\n';
  fs.writeFileSync(path.join(tmpDir, HISTORICAL_SCRIPT_NAME), historicalContent, 'utf8');

  // Файл README.md
  fs.writeFileSync(
    path.join(tmpDir, 'README.md'),
    '# AI MyWay DeN\n\nВерсия: **3.8**\n\nОписание проекта.\n',
    'utf8'
  );

  return { tmpDir, backupDir, mainContent, sampleBody, historicalContent };
}

function cleanupWorkspace(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
}

test('Управление версиями: валидация формата и числовой инкремент (не лексикографический)', () => {
  // Валидный формат
  assert.equal(validateVersionFormat('3.8'), '3.8');
  assert.equal(validateVersionFormat('3.9'), '3.9');
  assert.equal(validateVersionFormat('3.10'), '3.10');
  assert.equal(validateVersionFormat('2.4.7'), '2.4.7');

  // Невалидные форматы
  assert.throws(() => validateVersionFormat(''), /пустая или некорректная/);
  assert.throws(() => validateVersionFormat('abc'), /Недопустимый формат/);
  assert.throws(() => validateVersionFormat('3'), /Недопустимый формат/);
  assert.throws(() => validateVersionFormat('3.8-beta'), /Недопустимый формат/);

  // Сравнение версий (числовое: 3.10 > 3.9)
  assert.equal(compareVersions('3.8', '3.8'), 0);
  assert.equal(compareVersions('3.8', '3.9'), -1);
  assert.equal(compareVersions('3.9', '3.8'), 1);
  assert.equal(compareVersions('3.10', '3.9'), 1, '3.10 должно быть больше 3.9 (числовое, не лексикографическое)');
  assert.equal(compareVersions('3.9', '3.10'), -1);

  // Инкремент версии: 3.8 -> 3.9 -> 3.10 -> 3.11
  assert.equal(bumpVersion('3.8'), '3.9');
  assert.equal(bumpVersion('3.9'), '3.10');
  assert.equal(bumpVersion('3.10'), '3.11');
  assert.equal(bumpVersion('2.4.7'), '2.4.8');
});

test('Разбор userscript: детекция начала/конца заголовка и разделение на заголовок и тело', () => {
  const content = '// ==UserScript==\n// @name Test\n// ==/UserScript==\nconst a = 1;';
  const parsed = parseUserscript(content, 'test.js');
  assert.equal(parsed.directives.get('name')[0].value, 'Test');
  assert.equal(parsed.body, '\nconst a = 1;');

  assert.throws(() => parseUserscript('// no header\nconst a = 1;', 'err.js'), /отсутствует открывающий заголовок/);
  assert.throws(() => parseUserscript('// ==UserScript==\n// @name Test', 'err.js'), /отсутствует закрывающий маркер/);
});

test('Строгая валидация метаданных: одиночные директивы, дублирование и ошибочные URL', () => {
  const validHeader = [
    '// ==UserScript==',
    '// @name         AI MyWay DeN',
    '// @namespace    MyWay.Moswar',
    '// @version      3.8',
    '// @description  Описание',
    '// @updateURL    https://github.com/DeN07-ai/AI-Script-MyWay-Moswar/raw/refs/heads/main/AI%20MyWay%20DeN.user.js',
    '// @downloadURL  https://github.com/DeN07-ai/AI-Script-MyWay-Moswar/raw/refs/heads/main/AI%20MyWay%20DeN.user.js',
    '// ==/UserScript==',
  ].join('\n') + '\nbody';

  const validParsed = parseUserscript(validHeader, 'valid.js');
  const meta = validateMetadata(validParsed, 'main', 'valid.js');
  assert.equal(meta.name, 'AI MyWay DeN');
  assert.equal(meta.version, '3.8');

  // Дублированная версия
  const duplicateVersion = validHeader.replace('// @version      3.8', '// @version      3.8\n// @version      3.9');
  const dupParsed = parseUserscript(duplicateVersion, 'dup.js');
  assert.throws(() => validateMetadata(dupParsed, 'main', 'dup.js'), /дублируется директива @version/);

  // Дублированный @name
  const duplicateName = validHeader.replace('// @name         AI MyWay DeN', '// @name         AI MyWay DeN\n// @name Extra');
  const dupNameParsed = parseUserscript(duplicateName, 'dupName.js');
  assert.throws(() => validateMetadata(dupNameParsed, 'main', 'dupName.js'), /дублируется директива @name/);

  // Неправильный URL
  const wrongUrl = validHeader.replace('AI%20MyWay%20DeN.user.js', 'wrong.user.js');
  const wrongParsed = parseUserscript(wrongUrl, 'wrong.js');
  assert.throws(() => validateMetadata(wrongParsed, 'main', 'wrong.js'), /не совпадает с ожидаемым/);

  // Неправильный @name для роли
  const wrongRole = validHeader.replace('AI MyWay DeN', 'Some Other Name');
  const wrongRoleParsed = parseUserscript(wrongRole, 'wrongRole.js');
  assert.throws(() => validateMetadata(wrongRoleParsed, 'main', 'wrongRole.js'), /не соответствует ожидаемому/);
});

test('Генерация моста: сохранение метаданных совместимости и совпадение тела', () => {
  const { tmpDir, mainContent, sampleBody } = createFixtureWorkspace();
  try {
    const mainParsed = parseUserscript(mainContent, MAIN_SCRIPT_NAME);
    const generated = generateBridgeContent(mainParsed, '3.8');

    const bridgeParsed = parseUserscript(generated, BRIDGE_SCRIPT_NAME);
    const bridgeMeta = validateMetadata(bridgeParsed, 'bridge', BRIDGE_SCRIPT_NAME);

    assert.equal(bridgeMeta.name, 'MoswarBot by MY WAY DEN', 'Сохранён @name совместимости');
    assert.equal(bridgeMeta.namespace, 'MY WAY', 'Сохранён @namespace совместимости');
    assert.equal(bridgeMeta.version, '3.8', 'Версия совпадает с исходной');
    assert.equal(bridgeMeta.updateURL, EXPECTED_CONFIG.bridge.updateURL);
    assert.equal(bridgeMeta.downloadURL, EXPECTED_CONFIG.bridge.downloadURL);
    assert.equal(bridgeParsed.body, sampleBody, 'Тело моста строго совпадает с телом основного скрипта');
  } finally {
    cleanupWorkspace(tmpDir);
  }
});

test('Обычная сборка runBuild: генерация моста и повторный вызов без перезаписи', () => {
  const { tmpDir, backupDir } = createFixtureWorkspace();
  process.env.AI_SCRIPT_BACKUP_DIR = backupDir;

  try {
    const bridgePath = path.join(tmpDir, BRIDGE_SCRIPT_NAME);
    assert.equal(fs.existsSync(bridgePath), false, 'Мост изначально отсутствует');

    // Первая сборка — создаёт файл
    const res1 = runBuild(tmpDir);
    assert.equal(res1.updated, true);
    assert.equal(fs.existsSync(bridgePath), true);
    assert.equal(res1.version, '3.8');

    const mtime1 = fs.statSync(bridgePath).mtimeMs;

    // Вторая сборка — файл уже идентичен, перезапись не выполняется
    const res2 = runBuild(tmpDir);
    assert.equal(res2.updated, false);
    assert.match(res2.message, /уже актуален/);
    const mtime2 = fs.statSync(bridgePath).mtimeMs;
    assert.equal(mtime1, mtime2, 'Файл моста не перезаписывался повторно');
  } finally {
    delete process.env.AI_SCRIPT_BACKUP_DIR;
    cleanupWorkspace(tmpDir);
  }
});

test('Проверка runCheck: успешное прохождение и детекция рассинхронизации', () => {
  const { tmpDir } = createFixtureWorkspace();

  try {
    const bridgePath = path.join(tmpDir, BRIDGE_SCRIPT_NAME);

    // 1. Ошибка при отсутствии моста
    assert.throws(() => runCheck(tmpDir), /Файл совместимости \(мост\) отсутствует/);

    // Собираем мост
    runBuild(tmpDir);

    // 2. Успешный check
    const checkRes = runCheck(tmpDir);
    assert.equal(checkRes.version, '3.8');

    // 3. Ошибка при изменении тела моста (рассогласование кода)
    fs.appendFileSync(bridgePath, '\n// tampered body logic\n');
    assert.throws(() => runCheck(tmpDir), /Кодовая часть \(тело\) моста не совпадает/);

    // Пересобираем
    runBuild(tmpDir);

    // 4. Ошибка при несовпадении версий
    const bridgeContent = fs.readFileSync(bridgePath, 'utf8');
    const alteredVersionBridge = bridgeContent.replace(/\/\/\s*@version\s+\S+/, '// @version      3.7');
    fs.writeFileSync(bridgePath, alteredVersionBridge, 'utf8');
    assert.throws(() => runCheck(tmpDir), /Несовпадение версий/);
  } finally {
    cleanupWorkspace(tmpDir);
  }
});

test('Гарантия неизменяемости: runCheck и runPreview не модифицируют файлы', () => {
  const { tmpDir } = createFixtureWorkspace();

  try {
    runBuild(tmpDir);

    const mainPath = path.join(tmpDir, MAIN_SCRIPT_NAME);
    const bridgePath = path.join(tmpDir, BRIDGE_SCRIPT_NAME);

    const mainStatBefore = fs.statSync(mainPath);
    const bridgeStatBefore = fs.statSync(bridgePath);

    // Вызов runCheck
    runCheck(tmpDir);

    // Вызов runPreview в обычном режиме и в режиме релиза
    const preview1 = runPreview(tmpDir, false);
    assert.equal(preview1.willModifyMain, false);
    assert.equal(preview1.willModifyBridge, false);

    const preview2 = runPreview(tmpDir, true);
    assert.equal(preview2.mode, 'release');
    assert.equal(preview2.nextVersion, '3.9');

    // Проверяем, что метаданные и mtime файлов не изменились
    const mainStatAfter = fs.statSync(mainPath);
    const bridgeStatAfter = fs.statSync(bridgePath);

    assert.equal(mainStatBefore.mtimeMs, mainStatAfter.mtimeMs);
    assert.equal(bridgeStatBefore.mtimeMs, bridgeStatAfter.mtimeMs);
    assert.equal(mainStatBefore.size, mainStatAfter.size);
    assert.equal(bridgeStatBefore.size, bridgeStatAfter.size);
  } finally {
    cleanupWorkspace(tmpDir);
  }
});

test('Подготовка релиза runRelease: отмена пользователем не изменяет файлы', async () => {
  const { tmpDir } = createFixtureWorkspace();

  try {
    runBuild(tmpDir);
    const mainPath = path.join(tmpDir, MAIN_SCRIPT_NAME);
    const bridgePath = path.join(tmpDir, BRIDGE_SCRIPT_NAME);
    const mainBefore = fs.readFileSync(mainPath, 'utf8');
    const bridgeBefore = fs.readFileSync(bridgePath, 'utf8');

    // Имитация ответа "n" (отказ)
    const mockRl = {
      question: (prompt, cb) => cb('n'),
    };

    const res = await runRelease(tmpDir, { autoConfirm: false, rlInterface: mockRl });
    assert.equal(res.confirmed, false);
    assert.match(res.message, /Операция отменена/);

    const mainAfter = fs.readFileSync(mainPath, 'utf8');
    const bridgeAfter = fs.readFileSync(bridgePath, 'utf8');
    assert.equal(mainBefore, mainAfter, 'Основной файл не должен был измениться');
    assert.equal(bridgeBefore, bridgeAfter, 'Файл моста не должен был измениться');
  } finally {
    cleanupWorkspace(tmpDir);
  }
});

test('Подготовка релиза runRelease: повышение версии ровно 1 раз, бэкапы и обновление README', async () => {
  const { tmpDir, backupDir } = createFixtureWorkspace();
  process.env.AI_SCRIPT_BACKUP_DIR = backupDir;

  try {
    runBuild(tmpDir);
    const mainPath = path.join(tmpDir, MAIN_SCRIPT_NAME);
    const bridgePath = path.join(tmpDir, BRIDGE_SCRIPT_NAME);
    const readmePath = path.join(tmpDir, 'README.md');

    // Запуск подтвержденного релиза
    const res = await runRelease(tmpDir, { autoConfirm: true });
    assert.equal(res.confirmed, true);
    assert.equal(res.oldVersion, '3.8');
    assert.equal(res.newVersion, '3.9');
    assert.equal(res.readmeUpdated, true);

    // Проверяем файлы на диске
    const mainAfter = fs.readFileSync(mainPath, 'utf8');
    const bridgeAfter = fs.readFileSync(bridgePath, 'utf8');
    const readmeAfter = fs.readFileSync(readmePath, 'utf8');

    const mainParsed = parseUserscript(mainAfter, MAIN_SCRIPT_NAME);
    const bridgeParsed = parseUserscript(bridgeAfter, BRIDGE_SCRIPT_NAME);

    assert.equal(mainParsed.directives.get('version')[0].value, '3.9');
    assert.equal(bridgeParsed.directives.get('version')[0].value, '3.9');
    assert.equal(mainParsed.body, bridgeParsed.body, 'Тела обоих файлов после релиза идентичны');
    assert.match(readmeAfter, /Версия:\s*\*\*3\.9\*\*/);

    // Проверяем создание бэкапов
    assert.ok(res.mainBackup && fs.existsSync(res.mainBackup), 'Бэкап основного файла создан');
    assert.ok(res.bridgeBackup && fs.existsSync(res.bridgeBackup), 'Бэкап моста создан');

    // Проверяем, что runCheck проходит после релиза
    const checkRes = runCheck(tmpDir);
    assert.equal(checkRes.version, '3.9');

    // Повторный вызов обычной сборки runBuild НЕ повышает версию повторно
    const buildRes = runBuild(tmpDir);
    assert.equal(buildRes.version, '3.9');
    assert.equal(buildRes.updated, false, 'Повторный build не изменяет файлы');
  } finally {
    delete process.env.AI_SCRIPT_BACKUP_DIR;
    cleanupWorkspace(tmpDir);
  }
});

test('Сохранность проекта: историческая копия AI MyWay DeN.js никогда не изменяется', async () => {
  const { tmpDir, backupDir, historicalContent } = createFixtureWorkspace();
  process.env.AI_SCRIPT_BACKUP_DIR = backupDir;

  try {
    const historicalPath = path.join(tmpDir, HISTORICAL_SCRIPT_NAME);
    assert.equal(fs.readFileSync(historicalPath, 'utf8'), historicalContent);

    // Выполняем сборку
    runBuild(tmpDir);
    assert.equal(fs.readFileSync(historicalPath, 'utf8'), historicalContent);

    // Выполняем check и preview
    runCheck(tmpDir);
    runPreview(tmpDir, false);
    runPreview(tmpDir, true);
    assert.equal(fs.readFileSync(historicalPath, 'utf8'), historicalContent);

    // Выполняем релиз
    await runRelease(tmpDir, { autoConfirm: true });
    assert.equal(fs.readFileSync(historicalPath, 'utf8'), historicalContent, 'Историческая копия осталась неизменной');
  } finally {
    delete process.env.AI_SCRIPT_BACKUP_DIR;
    cleanupWorkspace(tmpDir);
  }
});

test('Резервное копирование backupFile: уникальные имена файлов, запрет перезаписи', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  try {
    const testFile = path.join(tmpDir, 'test-target.js');
    fs.writeFileSync(testFile, 'initial data', 'utf8');

    const backupDir = path.join(tmpDir, 'backups');
    const b1 = backupFile(testFile, backupDir);
    assert.ok(fs.existsSync(b1));

    // Изменяем файл и делаем второй бэкап
    fs.writeFileSync(testFile, 'modified data', 'utf8');
    const b2 = backupFile(testFile, backupDir);
    assert.ok(fs.existsSync(b2));

    assert.notEqual(b1, b2, 'Имена резервных копий должны быть уникальными');
    assert.equal(fs.readFileSync(b1, 'utf8'), 'initial data');
    assert.equal(fs.readFileSync(b2, 'utf8'), 'modified data');
  } finally {
    cleanupWorkspace(tmpDir);
  }
});

test('CLI интерфейс: запуск через process execFileSync с флагами --check, --preview, --release', () => {
  const { tmpDir, backupDir } = createFixtureWorkspace();
  const scriptPath = path.resolve(__dirname, '../scripts/build-release.mjs');
  const env = {
    ...process.env,
    AI_SCRIPT_ROOT: tmpDir,
    AI_SCRIPT_BACKUP_DIR: backupDir,
  };

  try {
    // 1. Сборка моста через CLI
    const buildOut = execFileSync(process.execPath, [scriptPath], { env, encoding: 'utf8' });
    assert.match(buildOut, /СБОРКА УСПЕШНО ЗАВЕРШЕНА/);

    // 2. Проверка через CLI --check
    const checkOut = execFileSync(process.execPath, [scriptPath, '--check'], { env, encoding: 'utf8' });
    assert.match(checkOut, /ПРОВЕРКА ПРОЙДЕНА УСПЕШНО/);

    // 3. Предпросмотр через CLI --preview
    const previewOut = execFileSync(process.execPath, [scriptPath, '--preview'], { env, encoding: 'utf8' });
    assert.match(previewOut, /ПРЕДПРОСМОТР ОПЕРАЦИИ/);

    // 4. Ошибка при проверке невалидного моста
    fs.appendFileSync(path.join(tmpDir, BRIDGE_SCRIPT_NAME), '\n// broken\n');
    assert.throws(
      () => execFileSync(process.execPath, [scriptPath, '--check'], { env, encoding: 'utf8', stdio: 'pipe' }),
      (err) => {
        assert.equal(err.status, 1, 'Должен вернуть код возврата 1 при ошибке проверки');
        return true;
      }
    );
  } finally {
    cleanupWorkspace(tmpDir);
  }
});

test('Безопасность Git: ни одна операция не инициирует git commit, git push или публикацию', () => {
  // Убеждаемся, что скрипт build-release.mjs не импортирует child_process и не выполняет системные команды git
  const scriptContent = fs.readFileSync(path.resolve(__dirname, '../scripts/build-release.mjs'), 'utf8');
  assert.equal(scriptContent.includes('child_process'), false, 'Скрипт не должен импортировать child_process');
  assert.equal(scriptContent.includes('exec('), false, 'Скрипт не должен вызывать exec()');
  assert.equal(scriptContent.includes('spawn('), false, 'Скрипт не должен вызывать spawn()');
  assert.equal(scriptContent.includes('execSync('), false, 'Скрипт не должен вызывать execSync()');
});
