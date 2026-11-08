# expo-splash-screen 58.0.12 for the launch screen

Without this package prebuild leaves the template's white launch screen and ignores `splash-icon.png`: the config
plugin that sets a splash background and image ships in it. The app calls none of its JavaScript. `expo-font` joins as a
direct dependency at the 58.0.11 that `expo` already installed, so its version does not change.

## expo-splash-screen none → 58.0.12

Source: mobile/node_modules/expo-splash-screen/CHANGELOG.md (58.0.0 through 58.0.12), and its Android and iOS sources for the hide path

- the launch screen shows the ground colour and the three dots, from the config plugin at prebuild · not covered: checked in the prebuild output; a phone shows it only after the next native build
- the native splash hides by itself at React Native's first content, because the app never calls `preventAutoHideAsync` · not covered: read in `SplashScreenManager`; needs a phone, and a splash that failed to hide would leave the app stuck at launch
- 58.0.10: Android stops keeping the main activity in memory after it is destroyed · not covered: the call service keeps the process alive across a swipe-away, and returning to a call needs a phone to prove
