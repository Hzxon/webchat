# Changelog

## [0.10.0](https://github.com/Hzxon/webchat/compare/v0.9.0...v0.10.0) (2026-11-13)


### ⚠ BREAKING CHANGES

* **agent:** the Claude Code plugin no longer hosts the agent. Plugin users must run `webchat-agent setup`, which needs administrator rights; without them there is no agent.

### Features

* **agent:** Approve harness actions from WebChat ([#204](https://github.com/Hzxon/webchat/issues/204)) ([c8b6b26](https://github.com/Hzxon/webchat/commit/c8b6b265d1da91d2a58e5f59ea93a6ca99e7f1f3))
* **agent:** Build the locked room in setup ([#208](https://github.com/Hzxon/webchat/issues/208)) ([502fa12](https://github.com/Hzxon/webchat/commit/502fa122c804a48b983be4e6cc2ba2ff83a4ccd2))
* **agent:** Connect a folder on the owner's go ([#202](https://github.com/Hzxon/webchat/issues/202)) ([1e9d444](https://github.com/Hzxon/webchat/commit/1e9d444e0772a63500d72c7b5145ee20e8cc0efc))
* **agent:** Follow the server's release ([#210](https://github.com/Hzxon/webchat/issues/210)) ([bcfde91](https://github.com/Hzxon/webchat/commit/bcfde91bd78b15c10282015b43395c48c107187d))
* **agent:** Join the keyholder and runner ([#207](https://github.com/Hzxon/webchat/issues/207)) ([e74ed0c](https://github.com/Hzxon/webchat/commit/e74ed0cabc59920e8c84c6a4496ba470c951c9be))
* **agent:** Link harnesses from a supported list ([#201](https://github.com/Hzxon/webchat/issues/201)) ([af3876c](https://github.com/Hzxon/webchat/commit/af3876cfd65ac3e9aab9f71d49e381481adcab98))
* **agent:** Retire the plugin host ([#209](https://github.com/Hzxon/webchat/issues/209)) ([f988e65](https://github.com/Hzxon/webchat/commit/f988e65e70659e37462f0d2bdf45d46430afcc75))
* **agent:** Run ACP agents from a shipped list ([#203](https://github.com/Hzxon/webchat/issues/203)) ([279a148](https://github.com/Hzxon/webchat/commit/279a14885166106090f8132cd1728fa06dc7d305))
* **agent:** Set up the agent with one command ([#200](https://github.com/Hzxon/webchat/issues/200)) ([45fb74d](https://github.com/Hzxon/webchat/commit/45fb74d04172d4af33bc8b1aa2d68a5de9960669))
* **agent:** Ship the agent as one file per OS ([#199](https://github.com/Hzxon/webchat/issues/199)) ([baf3ac9](https://github.com/Hzxon/webchat/commit/baf3ac9052547cd9aa66a4ba90ea6daa125c4721))
* **board:** Let a card's owner hold its gates ([#189](https://github.com/Hzxon/webchat/issues/189)) ([ef07569](https://github.com/Hzxon/webchat/commit/ef07569c4505d1d7937dba8b0bd24683b68f60b5))
* **board:** Review a card like a pull request ([#190](https://github.com/Hzxon/webchat/issues/190)) ([83b9d1d](https://github.com/Hzxon/webchat/commit/83b9d1d9e9e233484c81b17049e1d4ae6b26a0a8))
* **board:** Show the roadmap as lanes ([#188](https://github.com/Hzxon/webchat/issues/188)) ([35cc583](https://github.com/Hzxon/webchat/commit/35cc5832035f62872eb0fe8d55a96d238245fc34))


### Bug Fixes

* **agent:** Copy the board's statuses that stand ([#195](https://github.com/Hzxon/webchat/issues/195)) ([bd1ee0a](https://github.com/Hzxon/webchat/commit/bd1ee0a3d9474a48ceaa0845d4da8aa65abf8280))
* **agent:** Fsck a bundle's objects on old git ([#212](https://github.com/Hzxon/webchat/issues/212)) ([5621744](https://github.com/Hzxon/webchat/commit/56217441c68f0892c4aec1f4f9919fb36337274a))
* **board:** Keep a card's reviews on a hand edit ([#197](https://github.com/Hzxon/webchat/issues/197)) ([78ca9ba](https://github.com/Hzxon/webchat/commit/78ca9bae442fc4577a37f680bc01ac41839609d6))
* **board:** Keep one editor open per board ([#196](https://github.com/Hzxon/webchat/issues/196)) ([d02a761](https://github.com/Hzxon/webchat/commit/d02a761718c9fb8429498e5ccc0d2658c403777f))
* Close four gaps from the security audit ([#185](https://github.com/Hzxon/webchat/issues/185)) ([b9a8a67](https://github.com/Hzxon/webchat/commit/b9a8a67c77c3fa58e23131f7b8084cc9c8251748))

## [0.9.0](https://github.com/Hzxon/webchat/compare/v0.8.0...v0.9.0) (2026-11-09)


### Features

* **agent:** Answer questions through Codex ([#180](https://github.com/Hzxon/webchat/issues/180)) ([b31211b](https://github.com/Hzxon/webchat/commit/b31211bb4ed73cbc9a36db777264a40fcf06af4c))
* **agent:** Pick the harness in each request ([#179](https://github.com/Hzxon/webchat/issues/179)) ([c841b29](https://github.com/Hzxon/webchat/commit/c841b29c3fbc7e16e2ba2c00a5104f7e44ed5ea0))
* **agent:** Redirect a paused run with the owner's words ([#181](https://github.com/Hzxon/webchat/issues/181)) ([1f65564](https://github.com/Hzxon/webchat/commit/1f65564137121fa089b416daee7043d0fc804723))
* **agent:** Serve the agent from a daemon ([#177](https://github.com/Hzxon/webchat/issues/177)) ([87a842e](https://github.com/Hzxon/webchat/commit/87a842e535d0b431b500b3b3cb7b83402f9a78b3))
* **agent:** Show a run's plan before it commits ([#182](https://github.com/Hzxon/webchat/issues/182)) ([d961ab7](https://github.com/Hzxon/webchat/commit/d961ab72dc5eb8bfc028ab43fea6d683056c5657))
* **agent:** Show each harness in Settings ([#176](https://github.com/Hzxon/webchat/issues/176)) ([82bceeb](https://github.com/Hzxon/webchat/commit/82bceeb602d8e998fee7fa3bf99337794c523c4d))
* **agent:** Show progress and pause a run on Stop ([#178](https://github.com/Hzxon/webchat/issues/178)) ([aa32826](https://github.com/Hzxon/webchat/commit/aa328260242e672be47992cc2cd303497d38f964))


### Bug Fixes

* **board:** Keep one true status on a card ([#171](https://github.com/Hzxon/webchat/issues/171)) ([adc10a3](https://github.com/Hzxon/webchat/commit/adc10a3e358c5bbf6182caedfd5da6b8800d3b5e))

## [0.8.0](https://github.com/Hzxon/webchat/compare/v0.7.0...v0.8.0) (2026-11-07)


### Features

* **agent:** Check a new card and number it on the board ([#166](https://github.com/Hzxon/webchat/issues/166)) ([04939dc](https://github.com/Hzxon/webchat/commit/04939dc70241d988a301029a5eb3d09ddd0c01b7))
* **agent:** Let the owner choose the run's Claude setup ([#165](https://github.com/Hzxon/webchat/issues/165)) ([a7d4a87](https://github.com/Hzxon/webchat/commit/a7d4a87d116d204dd275f3b9f240ba5586f93f96))
* **agent:** Make a card run follow the workflow ([#168](https://github.com/Hzxon/webchat/issues/168)) ([260bcb7](https://github.com/Hzxon/webchat/commit/260bcb7ab7874161fded82105f268c615a60ff17))
* **agent:** Refresh a question's copy on reply ([#160](https://github.com/Hzxon/webchat/issues/160)) ([b1e1886](https://github.com/Hzxon/webchat/commit/b1e1886d6f8787a9fd9c7106542dce5af2b53f4a))
* **board:** Make the board the repository's source ([#167](https://github.com/Hzxon/webchat/issues/167)) ([dbf0c4f](https://github.com/Hzxon/webchat/commit/dbf0c4f3f4e17a0710a0c31ba7c25f72e6d55ff3))


### Bug Fixes

* **agent:** Release waiting turns on connect ([#156](https://github.com/Hzxon/webchat/issues/156)) ([2caebcf](https://github.com/Hzxon/webchat/commit/2caebcfa309c9b1ce271372c98fecf1e789063f2))
* **agent:** Tell questions that cards open PRs ([#158](https://github.com/Hzxon/webchat/issues/158)) ([b719eac](https://github.com/Hzxon/webchat/commit/b719eac80a2d4b75db228baf4c080323a60b93d2))
* **client:** Cancel a new card or doc section ([#163](https://github.com/Hzxon/webchat/issues/163)) ([8cf52eb](https://github.com/Hzxon/webchat/commit/8cf52eb4c9419995d4ad7f8042c3842c76051147))

## [0.7.0](https://github.com/Hzxon/webchat/compare/v0.6.2...v0.7.0) (2026-11-07)


### Features

* **agent:** Put the agent to sleep and wake it ([#153](https://github.com/Hzxon/webchat/issues/153)) ([d0b0446](https://github.com/Hzxon/webchat/commit/d0b04464f732a97adef56ad360dcc04c3b5d4b50))
* **client:** Stop a running card from the board ([#151](https://github.com/Hzxon/webchat/issues/151)) ([242020c](https://github.com/Hzxon/webchat/commit/242020cd204e747bdef8bcc71e9eaf581e35aa8b))


### Bug Fixes

* **agent:** Pin keys the owner checked ([#145](https://github.com/Hzxon/webchat/issues/145)) ([d9b66cc](https://github.com/Hzxon/webchat/commit/d9b66cc9925c59e35b20311761337c95b4e4d95b))
* **agents:** Refuse a card another agent runs ([#143](https://github.com/Hzxon/webchat/issues/143)) ([ecc1f0c](https://github.com/Hzxon/webchat/commit/ecc1f0c8a69d7c76f6d4cafbb1d869f621293d92))
* **chat:** Tie quotes and reactions to the target ([#144](https://github.com/Hzxon/webchat/issues/144)) ([7df13e5](https://github.com/Hzxon/webchat/commit/7df13e51d7af5f0e862ec39c0b01c6ec5253be76))
* **client:** Hold reloads while an editor is open ([#141](https://github.com/Hzxon/webchat/issues/141)) ([8bb102b](https://github.com/Hzxon/webchat/commit/8bb102b3e58ff4165446f6f7ce3c41b414a9bff5))
* **client:** Turn to Projects for an open board ([#140](https://github.com/Hzxon/webchat/issues/140)) ([e6a5b5a](https://github.com/Hzxon/webchat/commit/e6a5b5a614a895d152981dc076c93b400834dbb9))
* **e2ee:** Bind the chat id into a key's wrap ([#150](https://github.com/Hzxon/webchat/issues/150)) ([9cf76db](https://github.com/Hzxon/webchat/commit/9cf76db99eb01f68e76302fcd3568a11f813711b))
* **e2ee:** Never seal with a key a link replaced ([#146](https://github.com/Hzxon/webchat/issues/146)) ([e2fca2d](https://github.com/Hzxon/webchat/commit/e2fca2dc1545bb134efbd312920411e3862ede02))
* **e2ee:** Never seal with an old key copy ([#152](https://github.com/Hzxon/webchat/issues/152)) ([d74ec2a](https://github.com/Hzxon/webchat/commit/d74ec2a9d0af073e42329e2f29699473d8a249b4))
* **e2ee:** Share key checks; refuse looped chains ([#147](https://github.com/Hzxon/webchat/issues/147)) ([def9222](https://github.com/Hzxon/webchat/commit/def922250d736ba54fe7bf3b89e6d6325c737a33))
* **projects:** Never hand a project to an agent ([#154](https://github.com/Hzxon/webchat/issues/154)) ([c10cb88](https://github.com/Hzxon/webchat/commit/c10cb88390446577fb1762a2919d0b13d58173d2))

## [0.6.2](https://github.com/Hzxon/webchat/compare/v0.6.1...v0.6.2) (2026-11-06)


### Bug Fixes

* **client:** Keep dialogs open after a drag out ([#138](https://github.com/Hzxon/webchat/issues/138)) ([9f5f6d4](https://github.com/Hzxon/webchat/commit/9f5f6d4de081943ab95b4585ab606eaaa0b563e5))
* **client:** Reopen the board after a reload ([#135](https://github.com/Hzxon/webchat/issues/135)) ([e6bd452](https://github.com/Hzxon/webchat/commit/e6bd45213cbc8c9cebbf1dfff0bfc2680a95a3e2))
* **client:** Retry the pairing poll after errors ([#136](https://github.com/Hzxon/webchat/issues/136)) ([34bb7cf](https://github.com/Hzxon/webchat/commit/34bb7cf46da63e43e226052a7e44f85d3e37f04b))

## [0.6.1](https://github.com/Hzxon/webchat/compare/v0.6.0...v0.6.1) (2026-11-06)


### Bug Fixes

* **agent:** Keep the pairing code across a deploy ([#134](https://github.com/Hzxon/webchat/issues/134)) ([55e46c4](https://github.com/Hzxon/webchat/commit/55e46c4adccdd246c3abbd20f28d8c03dd3d3de1))

## [0.6.0](https://github.com/Hzxon/webchat/compare/v0.5.0...v0.6.0) (2026-11-06)


### Features

* **agent:** Run several cards at once ([#130](https://github.com/Hzxon/webchat/issues/130)) ([bafa605](https://github.com/Hzxon/webchat/commit/bafa60566a6650944dfa61472664ee0d8f3f3662))
* **agent:** Serve all repos from one window ([#131](https://github.com/Hzxon/webchat/issues/131)) ([eb0bf4b](https://github.com/Hzxon/webchat/commit/eb0bf4b6bebf201a356999fbbda1e09f02c162be))
* **agents:** List the agent pane by project ([#132](https://github.com/Hzxon/webchat/issues/132)) ([02b6773](https://github.com/Hzxon/webchat/commit/02b67730efce6915762317e09060db7d29c75c6b))


### Bug Fixes

* **agent:** Unwatch drafts the pane cannot show ([#127](https://github.com/Hzxon/webchat/issues/127)) ([d20d9d8](https://github.com/Hzxon/webchat/commit/d20d9d84b754471c38f7b8288edbba8f8b83a9de))

## [0.5.0](https://github.com/Hzxon/webchat/compare/v0.4.0...v0.5.0) (2026-11-06)


### Features

* **agent:** Add a sandboxed background Claude ([#114](https://github.com/Hzxon/webchat/issues/114)) ([395d0ed](https://github.com/Hzxon/webchat/commit/395d0ed7820eafa72008f664999a8bf0b3201750))
* **agent:** Answer prompts in the owner's chat ([#119](https://github.com/Hzxon/webchat/issues/119)) ([e47757d](https://github.com/Hzxon/webchat/commit/e47757df7522f062ec27075441eec527f8dfd27e))
* **agent:** Draft board cards from the pane ([#121](https://github.com/Hzxon/webchat/issues/121)) ([b76efec](https://github.com/Hzxon/webchat/commit/b76efecbb9bf11aa3796e8818e31d00e43f2dc12))
* **agent:** Run board cards from the pane ([#122](https://github.com/Hzxon/webchat/issues/122)) ([06dad3e](https://github.com/Hzxon/webchat/commit/06dad3e89d9f3d1a035957f02a1e1ab48fe81300))
* **agent:** Run cards in a background Claude ([#117](https://github.com/Hzxon/webchat/issues/117)) ([3cc8be1](https://github.com/Hzxon/webchat/commit/3cc8be1edf05d6318fa1c0ddf56d9ac3de485f3f))
* **client:** Add the Coding agents pane ([#120](https://github.com/Hzxon/webchat/issues/120)) ([d944faa](https://github.com/Hzxon/webchat/commit/d944faaaf709ec2fdff852912d86649f07bbd8ba))
* **projects:** Let the owner delete a channel ([#110](https://github.com/Hzxon/webchat/issues/110)) ([963e270](https://github.com/Hzxon/webchat/commit/963e270bd0e1ca90e2eb01d8898472cee4547bf6))


### Bug Fixes

* **agent:** Check in only from WebChat sessions ([#113](https://github.com/Hzxon/webchat/issues/113)) ([80235aa](https://github.com/Hzxon/webchat/commit/80235aa63e2cff595534f6055eb91ad92902d72e))
* **agent:** Keep a card's model from the secrets ([#118](https://github.com/Hzxon/webchat/issues/118)) ([d89209f](https://github.com/Hzxon/webchat/commit/d89209fda6c437983c2feb0f64e8377fd6ae7837))
* **agent:** Refuse a second run of a running card ([#115](https://github.com/Hzxon/webchat/issues/115)) ([1a36ad5](https://github.com/Hzxon/webchat/commit/1a36ad53b8497dffa2a500472cfc9bad350f210b))
* **agent:** Run cards only where a monitor listens ([#108](https://github.com/Hzxon/webchat/issues/108)) ([4b03832](https://github.com/Hzxon/webchat/commit/4b0383273caffe5f993c7e1958aaa7e441ddbff7))
* **board:** Show run state and stop repeat runs ([#116](https://github.com/Hzxon/webchat/issues/116)) ([406dda0](https://github.com/Hzxon/webchat/commit/406dda0ed46fb5df846bc3e10d0069027f5fcfd2))

## [0.4.0](https://github.com/Hzxon/webchat/compare/v0.3.0...v0.4.0) (2026-11-05)


### Features

* **agent:** Carry the address in the pairing code ([#101](https://github.com/Hzxon/webchat/issues/101)) ([d258016](https://github.com/Hzxon/webchat/commit/d258016175742c5389e68308fcfb27a5f9cbf192))
* **agent:** Let the owner remove an agent ([#105](https://github.com/Hzxon/webchat/issues/105)) ([ada5740](https://github.com/Hzxon/webchat/commit/ada574090b5e5729b14c2c8b7a3c762a18113fcb))
* **agent:** Take runs in every open repository ([#104](https://github.com/Hzxon/webchat/issues/104)) ([761f4ae](https://github.com/Hzxon/webchat/commit/761f4ae46dc9d8a43f711861431c007bcdcc841d))


### Bug Fixes

* **agent:** Accept plain http on .localhost hosts ([#106](https://github.com/Hzxon/webchat/issues/106)) ([fbdf742](https://github.com/Hzxon/webchat/commit/fbdf742f67fc26fdd53cb647a36bab23a85abc23))

## [0.3.0](https://github.com/Hzxon/webchat/compare/v0.2.0...v0.3.0) (2026-11-05)


### ⚠ BREAKING CHANGES

* **agent:** npm run agent -- signup and login are gone, and the API ignores owner at sign-up and sign-in. Pair a new agent with npm run agent -- pair; an existing one keeps running with watch.
* **agent:** `npm run agent -- allow` is gone. signup and login take the owner's username as their last argument, and an existing agent must sign in again with it before its play button shows.

### Features

* **agent:** Add a headless client for the agent ([0473e2e](https://github.com/Hzxon/webchat/commit/0473e2eea8a0ad25ef18776f17461222a63d9980))
* **agent:** Add a headless client, R-027 step 1 ([#85](https://github.com/Hzxon/webchat/issues/85)) ([ce6a991](https://github.com/Hzxon/webchat/commit/ce6a991f5e5feca70322e28e10f4e7f0af0fe109))
* **agent:** Add Codex and Hermes adapters ([#89](https://github.com/Hzxon/webchat/issues/89)) ([9a2d622](https://github.com/Hzxon/webchat/commit/9a2d622ac81810db94a1a9c2e797c4ce296bbada))
* **agent:** Add run requests and the card menu ([392be45](https://github.com/Hzxon/webchat/commit/392be451e88e16b434ab0a90fcb6d975661e6e82))
* **agent:** Add run requests and the card menu ([#86](https://github.com/Hzxon/webchat/issues/86)) ([0ccae2a](https://github.com/Hzxon/webchat/commit/0ccae2aa1465f969460ebe10b117150abd946441))
* **agent:** Offer only idle agents on a card ([bb32ddf](https://github.com/Hzxon/webchat/commit/bb32ddff139635c838068e86dd3291039e8335b6))
* **agent:** Offer only idle agents on a card ([9a84ef9](https://github.com/Hzxon/webchat/commit/9a84ef9dd4c83cd74b88c431516988caa32b735e))
* **agent:** Run cards from a Claude Code plugin ([#100](https://github.com/Hzxon/webchat/issues/100)) ([29792d7](https://github.com/Hzxon/webchat/commit/29792d7a1161397f1ab0c3f484a4c10fabc221db))
* **agent:** Run cards with Claude Code ([a63124c](https://github.com/Hzxon/webchat/commit/a63124c0a89dafe423ffc26fed0203c99cb6a523))
* **agent:** Run cards with Claude Code ([#87](https://github.com/Hzxon/webchat/issues/87)) ([5f6ff97](https://github.com/Hzxon/webchat/commit/5f6ff976d126cb03e5a4320a24dd12e4982ce8b1))
* **auth:** Allow one account per device ([#71](https://github.com/Hzxon/webchat/issues/71)) ([98ea5c8](https://github.com/Hzxon/webchat/commit/98ea5c8839535d0fe0ae6128345d1ca212fb55c4))
* **auth:** Delete an account from the sidebar ([#94](https://github.com/Hzxon/webchat/issues/94)) ([32f6f76](https://github.com/Hzxon/webchat/commit/32f6f76e9add32aa65757fa19e25b240a2a080e2))
* **docs:** Add a menu of doc actions to its row ([#80](https://github.com/Hzxon/webchat/issues/80)) ([8e74d62](https://github.com/Hzxon/webchat/commit/8e74d629e8ef866214e3e4d5de864ea5c8420c58))
* **projects:** Add a board of decisions and ideas ([#75](https://github.com/Hzxon/webchat/issues/75)) ([42ba8e0](https://github.com/Hzxon/webchat/commit/42ba8e0aefcc588c5c3e5194d197773fd56460e0))
* **projects:** Add shared Markdown docs ([#73](https://github.com/Hzxon/webchat/issues/73)) ([32ceaf2](https://github.com/Hzxon/webchat/commit/32ceaf2a5c273bdd771bf30de26cefb4a918dc91))
* **ui:** Show messages as a linear feed ([#78](https://github.com/Hzxon/webchat/issues/78)) ([2eb4710](https://github.com/Hzxon/webchat/commit/2eb4710536aa0dbb7c86510f5cc190e9adefad7a))
* **ui:** Use a work-tool palette and type ([#77](https://github.com/Hzxon/webchat/issues/77)) ([a4ae053](https://github.com/Hzxon/webchat/commit/a4ae053ffcb5a0e83e50ca95ae392f0f6de8acdc))


### Bug Fixes

* **agent:** Fail runs a daemon restart cut short ([#96](https://github.com/Hzxon/webchat/issues/96)) ([e7d7700](https://github.com/Hzxon/webchat/commit/e7d77002aeb452d574f07a062b4feff51d8c6221))
* **agent:** Resolve busy flag merge conflict ([a53d1fe](https://github.com/Hzxon/webchat/commit/a53d1fe3e8279de1b9e9f7a8408a3b5f2a7168f0))
* **agent:** Run any card the agent's owner picks ([#95](https://github.com/Hzxon/webchat/issues/95)) ([7c4a206](https://github.com/Hzxon/webchat/commit/7c4a206780e6314933f6b2d03c79ca2e61dd1afa))
* **agent:** Run only cards allowed people wrote ([#92](https://github.com/Hzxon/webchat/issues/92)) ([8d06b2a](https://github.com/Hzxon/webchat/commit/8d06b2ab0faff23cdcc757767232ee5076df84cc))
* **agent:** Set the agent flag at sign-in too ([#91](https://github.com/Hzxon/webchat/issues/91)) ([1ce5f52](https://github.com/Hzxon/webchat/commit/1ce5f5231130e46f643a6d09306471890733a123))
* **projects:** Add card delete and align the heads ([#79](https://github.com/Hzxon/webchat/issues/79)) ([0c22a36](https://github.com/Hzxon/webchat/commit/0c22a36d037bbdadf8362a7fa037bbc0f123e2c9))


### Reverts

* Show messages as bubbles again, not a feed ([#81](https://github.com/Hzxon/webchat/issues/81)) ([0691d08](https://github.com/Hzxon/webchat/commit/0691d08fae6cb8073a628bff0d75e97fdc2c4107))

## [0.2.0](https://github.com/Hzxon/webchat/compare/v0.1.1...v0.2.0) (2026-11-03)


### Features

* **github:** Name an organization hiding pulls ([#34](https://github.com/Hzxon/webchat/issues/34)) ([fcf6c82](https://github.com/Hzxon/webchat/commit/fcf6c82c423d6595bae6c40f6156d325ab6369ea))
* **push:** Ring urgent messages like an alarm ([#69](https://github.com/Hzxon/webchat/issues/69)) ([3aafd43](https://github.com/Hzxon/webchat/commit/3aafd43473f078fb169e34e645f0fe8573deb340))


### Bug Fixes

* **auth:** Count only failed sign-ins in the limit ([#52](https://github.com/Hzxon/webchat/issues/52)) ([4038758](https://github.com/Hzxon/webchat/commit/4038758b13e98343b3cccc941af492871c59bbb8))
* **auth:** Forget keys when a session expired ([#56](https://github.com/Hzxon/webchat/issues/56)) ([c9dd46c](https://github.com/Hzxon/webchat/commit/c9dd46c98246bba35a70f3355ef9dd03fad3b6e6))
* **chat:** Alert for a missed urgent message ([#65](https://github.com/Hzxon/webchat/issues/65)) ([c801d07](https://github.com/Hzxon/webchat/commit/c801d07b9dd5fd3ea600bf1780059d5f0c264a45))
* **chat:** Send a chat's messages one at a time ([#53](https://github.com/Hzxon/webchat/issues/53)) ([f642a28](https://github.com/Hzxon/webchat/commit/f642a284e8cf0ac786a7093bfb8ea5ca61d7e7ea))
* **chat:** Store a retried send once ([#35](https://github.com/Hzxon/webchat/issues/35)) ([6ba0940](https://github.com/Hzxon/webchat/commit/6ba09400654208b3075f34d89f3109b601221dbe))
* **chat:** Time out requests that never end ([#61](https://github.com/Hzxon/webchat/issues/61)) ([232b494](https://github.com/Hzxon/webchat/commit/232b494a92f7d190876685e6c99b604ece4aa933))
* **db:** Honor sslmode=disable in DATABASE_URL ([#46](https://github.com/Hzxon/webchat/issues/46)) ([bd52144](https://github.com/Hzxon/webchat/commit/bd52144c0ecce685e6b77dd9a440f4897f5c387c))
* **db:** Skip TLS for the IPv6 loopback address ([#63](https://github.com/Hzxon/webchat/issues/63)) ([f03825b](https://github.com/Hzxon/webchat/commit/f03825beb222b5f94524aff62768bad82c8c6505))
* **e2ee:** Open held messages after a key check ([#42](https://github.com/Hzxon/webchat/issues/42)) ([9744ce1](https://github.com/Hzxon/webchat/commit/9744ce1e327edf565a6e8ce1d5e7eaa49a093749))
* **e2ee:** Pad message content to fixed sizes ([#33](https://github.com/Hzxon/webchat/issues/33)) ([156be90](https://github.com/Hzxon/webchat/commit/156be902018f75161dd4f46b4409edc776295264))
* **e2ee:** Refuse duplicate ids in key lists ([#62](https://github.com/Hzxon/webchat/issues/62)) ([3d59d04](https://github.com/Hzxon/webchat/commit/3d59d04a8f32d727c4c1a6ff79f40c3d76a1cd5a))
* **e2ee:** Take the group lock for its first key ([#50](https://github.com/Hzxon/webchat/issues/50)) ([7287e9b](https://github.com/Hzxon/webchat/commit/7287e9b6056736a3bef503304df81b9915ba9e10))
* **e2ee:** Trust nothing from unchecked keys ([#31](https://github.com/Hzxon/webchat/issues/31)) ([6585807](https://github.com/Hzxon/webchat/commit/6585807a2db0b98075a9341639712e9e4e878845))
* **projects:** Share one channel name rule ([#51](https://github.com/Hzxon/webchat/issues/51)) ([b69d9b9](https://github.com/Hzxon/webchat/commit/b69d9b9bfed985679b966b186d324635ac9d0c82))
* **projects:** Wrap long names in the preview ([#59](https://github.com/Hzxon/webchat/issues/59)) ([7d94605](https://github.com/Hzxon/webchat/commit/7d94605fb63151993106e386c7ab177c80645a25))
* **push:** Delete the endpoint a worker replaced ([#60](https://github.com/Hzxon/webchat/issues/60)) ([679d8fc](https://github.com/Hzxon/webchat/commit/679d8fc876f1674748f9f1cbf86664aab7adcbad))
* **push:** Drop a subscription with bad keys ([#43](https://github.com/Hzxon/webchat/issues/43)) ([4cadbd6](https://github.com/Hzxon/webchat/commit/4cadbd6c19c44275a5d50d4216642687163e6878))
* **push:** Hide the enable button on old iOS ([#57](https://github.com/Hzxon/webchat/issues/57)) ([6600469](https://github.com/Hzxon/webchat/commit/66004697f33b7b5bbf6da415a85eb5022ca114df))
* **push:** Keep a reaction from replacing an alert ([#45](https://github.com/Hzxon/webchat/issues/45)) ([95cbfd7](https://github.com/Hzxon/webchat/commit/95cbfd7c0504210a04f95ad11b8a9c19b52cdd43))
* **push:** Say iOS 16.4 is needed on older iPhones ([#48](https://github.com/Hzxon/webchat/issues/48)) ([8aebc06](https://github.com/Hzxon/webchat/commit/8aebc06da7fdecc894b24a3974cdf37c79dbf8cd))
* **push:** Tell pages of a replaced subscription ([#49](https://github.com/Hzxon/webchat/issues/49)) ([670fba5](https://github.com/Hzxon/webchat/commit/670fba531ad71c91497d889cc2e7e6a189fd9f74))
* **push:** Unsubscribe when the session expires ([#47](https://github.com/Hzxon/webchat/issues/47)) ([27ed7c9](https://github.com/Hzxon/webchat/commit/27ed7c9fd0641ebd7f771a5ce4a9ff5446ca33bb))
* Reload tabs only when the page changes ([#66](https://github.com/Hzxon/webchat/issues/66)) ([be4f5a5](https://github.com/Hzxon/webchat/commit/be4f5a5f7d59d22334f862dd4feb2239b1967973))
* **sync:** Drop a sync answer older than an edit ([#44](https://github.com/Hzxon/webchat/issues/44)) ([6425339](https://github.com/Hzxon/webchat/commit/642533923d20219340375b14e1a38720f3988949))
* **ui:** Fit the chat to the phone's width ([#70](https://github.com/Hzxon/webchat/issues/70)) ([018f61a](https://github.com/Hzxon/webchat/commit/018f61a23e5ecc6aaa7681d6bdb8080e38011730))
* **ui:** Wrap long names in dialog titles ([#67](https://github.com/Hzxon/webchat/issues/67)) ([3e16af2](https://github.com/Hzxon/webchat/commit/3e16af2e6549eaff40fad380b41532bfba53ee44))

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
