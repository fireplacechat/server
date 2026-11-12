# Contributing

This is the public Fireplace server: the Firestore rules, the Cloud Functions and their tests. The app is [fireplacechat/mobile](https://github.com/fireplacechat/mobile).

Bug fixes and tests are the most welcome changes. Open an issue before a large change.

The server only ever holds ciphertext and public keys. Do not add a field that would let it read message text, contact lists or private keys. The spam filter's real thresholds are not in this repository.

Before a pull request that changes code or other project files, agree once to the [Contributor License Agreement](https://github.com/fireplacechat/mobile/blob/main/.github/CLA.md). If an AI tool helped, follow the [AI policy](https://github.com/fireplacechat/mobile/blob/main/.github/AI_POLICY.md) and say which tool in the pull request.

Licence: [AGPL-3.0](LICENSE).
