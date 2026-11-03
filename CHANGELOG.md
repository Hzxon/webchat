# Changelog

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
