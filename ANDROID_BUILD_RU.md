# Сборка APK для Android

В проект уже добавлен GitHub Actions workflow для автоматической сборки APK в облаке. Это позволяет собрать APK без установки Android Studio на свой компьютер.

## Вариант 1 — собрать APK через GitHub (проще)
1. Создайте репозиторий на GitHub и загрузите туда **все файлы и папки проекта** из архива.
2. Откройте вкладку **Actions** в репозитории.
3. Выберите workflow **Build Masterok APK**.
4. Нажмите **Run workflow** → ещё раз **Run workflow**.
5. Дождитесь зелёной галочки завершения сборки.
6. Внизу страницы запуска, в разделе **Artifacts**, скачайте `masterok-debug-apk`.
7. Распакуйте скачанный архив — внутри будет `app-debug.apk`. Перешлите APK на Android-телефон и установите его. Если Android спросит разрешение, разрешите установку из этого источника.

При каждом обновлении исходников повторяйте запуск workflow. Для первого запуска GitHub может попросить включить Actions.

## Вариант 2 — собрать локально через Android Studio

Требуется Windows 10/11, Node.js 20 LTS, JDK 17 и Android Studio с установленным Android SDK.

В папке проекта откройте терминал и выполните:

```bash
npm install
npx cap add android
npx cap sync android
npx cap open android
```

Дождитесь синхронизации Gradle. Затем в Android Studio выберите **Build → Build Bundle(s) / APK(s) → Build APK(s)**.

Готовый debug APK появится здесь:

`android/app/build/outputs/apk/debug/app-debug.apk`

Для повторной сборки после изменений:

```bash
npx cap sync android
```

Затем снова соберите APK в Android Studio или командой `cd android && gradlew.bat assembleDebug` в Windows.

## Важно
- Папка `android/` создаётся при первой сборке командой `npx cap add android` — в архиве её пока нет.
- Debug APK подходит для установки и личного тестирования. Для публикации в Google Play понадобится подписанная release-сборка.
- Данные хранятся локально на устройстве. Регулярно экспортируйте резервную копию через раздел проектов.
