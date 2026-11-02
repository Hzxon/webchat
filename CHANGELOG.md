# Changelog

## [0.1.1](https://github.com/Hzxon/webchat/compare/v0.1.0...v0.1.1) (2026-11-02)


### Bug Fixes

* **client:** Reject a 2xx answer that breaks off ([#27](https://github.com/Hzxon/webchat/issues/27)) ([c75767b](https://github.com/Hzxon/webchat/commit/c75767b7ae2d3383632529af2e46d3dcdf60c90a))
* **github:** Alert with every tab closed ([#29](https://github.com/Hzxon/webchat/issues/29)) ([2f455b1](https://github.com/Hzxon/webchat/commit/2f455b12e53d77571d16cc433bae9687843b013d))

## 0.1.0 (2026-11-02)


### ⚠ BREAKING CHANGES

* Register and login take a login key derived in the browser instead of the password, and messages must be sent encrypted. Existing accounts upgrade once by entering their password.

### Features

* Add end-to-end message encryption ([10ba6d8](https://github.com/Hzxon/webchat/commit/10ba6d85ebbf758e0a88b46a723ad0bb266294eb))
* Add GitHub connector for pull requests ([#1](https://github.com/Hzxon/webchat/issues/1)) ([1d71a9d](https://github.com/Hzxon/webchat/commit/1d71a9de7a777a7c163c2230edecafab71a2f9b7))
* Add project and group owner controls ([#4](https://github.com/Hzxon/webchat/issues/4)) ([5e70ead](https://github.com/Hzxon/webchat/commit/5e70ead369b523f52a9e164e9f20d0da0176ac17))
* Add projects, replies and reactions ([#2](https://github.com/Hzxon/webchat/issues/2)) ([806dab9](https://github.com/Hzxon/webchat/commit/806dab93fb7e0f9f7f651480c60c076a38fbe435))
* Add web chat with push notifications ([74d53ff](https://github.com/Hzxon/webchat/commit/74d53ff32c74955e2bca310f375242b77bafeecc))
* **github:** Link repositories with a GitHub App ([#17](https://github.com/Hzxon/webchat/issues/17)) ([de431bb](https://github.com/Hzxon/webchat/commit/de431bb3f3bc24bd954c43f2cb76677bd0841b1d))
* **github:** Share a pull request into a chat ([#8](https://github.com/Hzxon/webchat/issues/8)) ([c7cff12](https://github.com/Hzxon/webchat/commit/c7cff1272b4b5dd85d4387b5c35e7f42d3743a1b))
* **github:** Share new pull requests in projects ([#14](https://github.com/Hzxon/webchat/issues/14)) ([186e2bf](https://github.com/Hzxon/webchat/commit/186e2bf06f1d953be3506474e57c2c8f24cb5075))
* Let any member add people to a group ([#10](https://github.com/Hzxon/webchat/issues/10)) ([12586ac](https://github.com/Hzxon/webchat/commit/12586ac7a26b611587f2e94248f87b9624403b49))
* **push:** Alert iPhones on iOS 15 through Bark ([#23](https://github.com/Hzxon/webchat/issues/23)) ([fd3210b](https://github.com/Hzxon/webchat/commit/fd3210bee10969089ae2667511d429920a5055c6))
* Rotate keys on removal and let people leave ([#13](https://github.com/Hzxon/webchat/issues/13)) ([df1e3ad](https://github.com/Hzxon/webchat/commit/df1e3ad2f50491057b6a2af868b9da8224ea55a7))


### Bug Fixes

* **api:** Read the query string without url.parse ([d4083df](https://github.com/Hzxon/webchat/commit/d4083df35c739d2adcc397a9991fbed2c0617aba))
* Close 15 bugs from a review of main ([#15](https://github.com/Hzxon/webchat/issues/15)) ([643ba6f](https://github.com/Hzxon/webchat/commit/643ba6f6165024c6d9c18437913cf84ab78e4e91))
* Close known issues K-1 to K-4 ([#6](https://github.com/Hzxon/webchat/issues/6)) ([6618f27](https://github.com/Hzxon/webchat/commit/6618f2712d9413fb55917e78fc6088e025373455))
* Keep drafts and unsent messages on the device ([#19](https://github.com/Hzxon/webchat/issues/19)) ([e214fbe](https://github.com/Hzxon/webchat/commit/e214fbea6194903a17d99041e566db49e91d056c))
* Keep tabs on the account the browser uses ([b75d690](https://github.com/Hzxon/webchat/commit/b75d690aab4a0f6aed94b9cdbe462ab600ab3d35))
* Keep the chat header above the iOS keyboard ([#21](https://github.com/Hzxon/webchat/issues/21)) ([aeee998](https://github.com/Hzxon/webchat/commit/aeee998af5563715dd020ed35ce98f8d707998b5))
* Keep the open chat when a deploy reloads ([#18](https://github.com/Hzxon/webchat/issues/18)) ([c38dc14](https://github.com/Hzxon/webchat/commit/c38dc14fa4546f3374536849fbbc126095e438e7))
* Stop the page sliding as the keyboard opens ([#22](https://github.com/Hzxon/webchat/issues/22)) ([b0e866b](https://github.com/Hzxon/webchat/commit/b0e866b839f3f679539cffc03e9e57815f1a1572))
* Support phone layout responsive on iOS before 16.4 ([#20](https://github.com/Hzxon/webchat/issues/20)) ([1cb1d9f](https://github.com/Hzxon/webchat/commit/1cb1d9f6cefa7ad6de2dc9d08f8132fc91c1dd2c))
