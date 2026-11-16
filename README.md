# Fireplace server

Security rules and Cloud Functions for [Fireplace](https://github.com/fireplacechat/mobile). The server stores public keys and ciphertext. Message text stays on the devices.

`functions/lib/spam-policy.ts` is not the deployed policy. It queues every report for a person. Operator tools are not included.

## Tests

The code is TypeScript. Node 22.18 or newer (it runs TypeScript files as they are), Java 21, and the Firebase CLI:

```sh
npm ci --prefix firebase
npm ci --prefix functions && npm test --prefix functions
firebase emulators:exec --only firestore,auth --project demo-fireplace "cd firebase && npm test"
```

`npm test` checks the types first. `npm run build --prefix functions` compiles the functions to `functions/build/`, which is what a deploy uploads.

## Cryptography notice

Some countries restrict importing, keeping, using, or sending encryption software to another country. Check the law that applies to you before you use or share this code.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). The [AI policy](https://github.com/fireplacechat/mobile/blob/main/.github/AI_POLICY.md) and [Contributor License Agreement](https://github.com/fireplacechat/mobile/blob/main/.github/CLA.md) apply.

## Licence

[AGPL-3.0](LICENSE).
