/**
 * 抽屉动画时长。单独一个文件是为了让 store 与 CSS 有唯一的对账点：
 * store 里的吸附回调要等动画跑完再改 open 状态，写错就会闪。
 * 改这里必须同时改 styles.css 里 .drawer 的 transition 时长。
 */
export const DRAWER_SETTLE_MS = 220;
