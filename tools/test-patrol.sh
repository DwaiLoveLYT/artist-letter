#!/usr/bin/env bash
# ============================================================
#  验证云端巡检的**报警分支真的会报警**
# ============================================================
#
# 为什么必须有这个文件：
# 一个永远不会报警的检查等于没有 —— 而且它比「没有检查」更危险，
# 因为它会让你以为这件事有人看着。
#
# 做法：把 tools/patrol.sh 复制一份、**故意弄坏某一处**，然后跑它，
# 断言两件事：① 退出码非 0（真的报红了）；② 报出的那句话是我们期望的那句
# （报红了但报错了原因，同样是坏的检查）。
#
# 最后再跑一次**没被改过的原版**，断言它是绿的 ——
# 否则上面每一条都可能只是「这个脚本本来就永远失败」。
#
# 每给 patrol.sh 加一条检查，就到这里给它配一个变体。
#
# 用法：bash tools/test-patrol.sh
set -uo pipefail

cd "$(dirname "$0")/.."
SRC="tools/patrol.sh"
D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT

PASS=0
FAIL=0

# 快速模式：把超时从 30 秒压到 6 秒、去掉重试。
# **只改等待时间，不改任何判定逻辑** —— 11 个变体 × 每个十几条请求，
# 用真实超时跑要几分钟，会被外层掐掉。断言的东西完全一样。
FAST=(-e 's|--max-time 30|--max-time 6|g' -e 's|--retry 2 --retry-delay 3|--retry 0|g')

# run_case <名字> <期望输出里出现的字符串> <sed 参数...>
run_case(){
  local name="$1" want="$2"; shift 2
  sed "${FAST[@]}" "$@" "$SRC" > "$D/v.sh"
  local out rc
  out="$(bash "$D/v.sh" 2>&1)"; rc=$?
  if [ "$rc" = "0" ]; then
    printf '  ❌ %s\n     变体居然跑绿了 —— 这条检查是哑的，报警分支根本没被走到\n' "$name"
    FAIL=$((FAIL+1)); return
  fi
  if printf '%s' "$out" | grep -qF -- "$want"; then
    printf '  ✅ %s\n     → 正确报出「%s」\n' "$name" "$want"
    PASS=$((PASS+1))
  else
    printf '  ❌ %s\n     报红了，但没说对原因。期望含「%s」，实际输出：\n' "$name" "$want"
    printf '%s\n' "$out" | grep -E '^❌|^⚠️' | sed 's/^/       /'
    FAIL=$((FAIL+1))
  fi
}

printf '\n== 先确认原版是绿的（否则下面全是假阳性）==\n'
sed "${FAST[@]}" "$SRC" > "$D/orig.sh"
orig_out="$(bash "$D/orig.sh" 2>&1)"; orig_rc=$?
if [ "$orig_rc" = "0" ]; then
  printf '  ✅ 原版 patrol.sh 通过（退出码 0）\n'; PASS=$((PASS+1))
else
  printf '  ❌ 原版 patrol.sh 就是红的！先修它，否则下面的结论没意义\n'
  printf '%s\n' "$orig_out" | grep -E '^❌' | sed 's/^/       /'
  FAIL=$((FAIL+1))
fi

printf '\n== 逐条验证报警分支 ==\n'

run_case "① 客户页同步脚本 404" \
  "客户页同步脚本取不到" \
  -e 's|"$SITE/cloud.js"|"$SITE/cloud-NOPE.js"|'

run_case "③ 地址回的不是我们的服务（200 但是别人的页面）" \
  "这个地址回的不是我们的服务" \
  -e 's|"$API/api/health"|"$SITE/index.html"|'

run_case "④ 客户页打不开" \
  "页面打不开" \
  -e 's|for p in "" "admin/"|for p in "nope-page/" "admin/"|'

run_case "⑤ 线上少了新功能标记（被回滚成旧版）" \
  "少了「信封正反面并排展示」" \
  -e 's|chk app.js         "env-pair"|chk app.js         "env-pair-NOPE"|'

run_case "⑥ CSS 取不到" \
  "静态资源取不到" \
  -e 's|for f in "style.css" "admin/admin.css"|for f in "style-NOPE.css" "admin/admin-NOPE.css"|'

run_case "⑥ 收款码 404（客户看不到二维码）" \
  "收款码取不到" \
  -e 's|"$SITE/images/pay-qr.jpg"|"$SITE/images/pay-qr-NOPE.jpg"|'

run_case "⑥ 收款码不是图片（被换成错误页，但 HTTP 200）" \
  "收款码不是一张 JPEG" \
  -e 's|"$SITE/images/pay-qr.jpg"|"$SITE/index.html"|'

run_case "⑦ 后端连不上数据仓库（503 是那条关键信号）" \
  "查单接口异常" \
  -e 's|/api/order/AL19990101ZZZZZZ?phone=0000|/api/order/AL19990101ZZZZZZ|'

run_case "⑧ 下单接口路由坏了" \
  "下单接口异常" \
  -e 's|"$API/api/order" 2>/dev/null|"$API/api/order-NOPE" 2>/dev/null|'

run_case "⑨ 数据仓库被公开（客户地址全世界可下载）" \
  "数据仓库被公开了" \
  -e 's|"$DATA_RAW/data/deleted.json"|"https://raw.githubusercontent.com/DwaiLoveLYT/artist-letter/main/tools/patrol.sh"|'

printf '\n== 汇总 ==\n'
printf '  通过 %d 条，失败 %d 条\n' "$PASS" "$FAIL"
if [ "$FAIL" != "0" ]; then
  printf '\n⚠️ 有检查是哑的 —— 它在你电脑睡着的时候不会救你。先修它。\n'
  exit 1
fi
printf '\n✅ 每一条检查都真的会报警。\n'
