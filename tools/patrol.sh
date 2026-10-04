#!/usr/bin/env bash
# ============================================================
#  云端巡检 —— 只做一件事：回答「客户的订单管道现在还通吗」
# ============================================================
#
# 这个脚本**跑在 GitHub 的服务器上**，和 DWAY 的电脑开不开机、有没有休眠
# 没有任何关系。这是它存在的唯一理由：
# WorkBuddy 里的定时任务依赖本机，电脑睡了就不触发；
# 而「后端挂了 / 前端指着旧地址」这两种故障**恰恰最容易发生在半夜**。
#
# 设计上刻意做到三件事：
#   ① **不需要任何密钥**。只打公开的 GET，所以没有 secret 要维护、也不会泄漏。
#   ② **不需要维护第二份地址副本**。后端地址是**从线上 cloud.js 里读出来的** ——
#      于是「前端还指着旧地址、后端已经搬走」这个最致命的状态，在这里必然报红。
#      如果改成在这里写死一个地址，那这条检查就废了（它会一直检查那个写死的地址）。
#   ③ **失败要吵**。退出码非 0 → Actions 任务失败 → GitHub 给仓库主人发邮件；
#      调用方（workflow）还会开一个 Issue。静默的成功是没用的，静默的失败更糟。
#
# 用法：bash tools/patrol.sh
set -uo pipefail

SITE="https://dwailovelyt.github.io/artist-letter/h5"
FAIL=0

note(){ printf '%s\n' "$*"; }
bad(){ FAIL=1; printf '❌ %s\n' "$*"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 统一的取文件：超时 30 秒、失败重试 2 次（GitHub Pages / 沙箱偶尔抽一下，不该直接判死）
get(){ # get <url> <输出文件>  → 回显 HTTP 码
  curl -sS -o "$2" -w '%{http_code}' --max-time 30 --retry 2 --retry-delay 3 "$1" 2>/dev/null || echo 000
}

note "巡检时间：$(date -u '+%Y-%m-%d %H:%M UTC')"
note "站点：$SITE"
note ""

# ---------- ① 客户页同步脚本必须取得到 ----------
code="$(get "$SITE/cloud.js" "$tmp/cloud.js")"
if [ "$code" != "200" ]; then
  bad "客户页同步脚本取不到（HTTP $code）：$SITE/cloud.js"
  note "    这一条断了，所有客户的页面都连不上后端 —— 最高优先级。"
fi

# ---------- ② 从**线上文件本身**读出后端地址 ----------
API=""
if [ -s "$tmp/cloud.js" ]; then
  API="$(sed -nE "s/.*CLOUD_BASE_DEFAULT[[:space:]]*=[[:space:]]*'([^']+)'.*/\1/p" "$tmp/cloud.js" | head -1)"
fi
if [ -z "$API" ]; then
  bad "读不出 cloud.js 里的 CLOUD_BASE_DEFAULT（文件结构变了？）"
  note "    这本身就是要立刻看的事：读不出地址 = 页面拿不到后端地址。"
else
  note "线上前端指向的后端：$API"

  # ---------- ③ 后端必须活着，而且必须是**我们的**服务 ----------
  #
  # 只看 HTTP 200 是不够的：历史上作废的地址回的是 HTTP 400 + 一张别人的营销页；
  # 但状态码是**别人的服务器**说了算 —— 哪天它改成 200，只看状态码就会把
  # 「完全不是我们服务的页面」判成活地址。所以必须验 service 字段。
  hc="$(get "$API/api/health" "$tmp/health.json")"
  if [ "$hc" != "200" ]; then
    bad "后端没有回应（HTTP $hc）：$API/api/health"
    note "    沙箱可能被回收了。需要重新发布后端 —— 注意：重发很可能会换地址，"
    note "    换地址后必须走完「set-endpoint → push-github → wait-cdn → 更新各处地址副本」六步。"
  elif ! grep -q '"service":"artist-letter-api"' "$tmp/health.json"; then
    bad "这个地址回的不是我们的服务，内容：$(head -c 160 "$tmp/health.json" | tr -d '\n')"
  else
    note "后端健康：$(head -c 220 "$tmp/health.json" | tr -d '\n')"
    # ⚠ health 里的 orders 是「内存里的单数、没有对账」，不是权威值，别拿它判断台账有几单。
    #    loaded:false 只代表冷启动中（沙箱空闲会被回收），再请求一次就好，不是故障。
  fi
fi

# ---------- ④ 两个页面必须能打开 ----------
for p in "" "admin/"; do
  c="$(get "$SITE/$p" "$tmp/page.html")"
  [ "$c" = "200" ] || bad "页面打不开（HTTP $c）：$SITE/$p"
done

# ---------- ⑤ 线上前端必须还带着「已经上线了」的功能标记 ----------
#
# 这一条挡的是「线上被回滚成旧版」。那种事**不会报错**：
# 客户只是少了几个状态、看不到信封照片、视频又打不开了 —— 而你不知道。
# 每个标记都对应一次真实的客户反馈，删任何一个都要有理由。
chk(){ # chk <仓库内相对路径> <必须存在的字符串> <人话>
  local f="$1" needle="$2" human="$3"
  local c
  c="$(get "$SITE/$f" "$tmp/f")"
  if [ "$c" != "200" ]; then bad "取不到 $f（HTTP $c）"; return; fi
  if ! grep -qF -- "$needle" "$tmp/f"; then
    bad "线上 $f 里少了「$human」—— 线上很可能是旧版"
  fi
}
chk app.js         "key:'drawn'"       "「绘制完成 / 准备寄出」两个状态"
chk app.js         "env-pair"          "信封正反面并排展示"
chk app.js         'loading="lazy"'    "图片按需加载"
chk app.js         "img-loaded"        "骨架占位动画到位后停止"
chk admin/admin.js "grabPoster"        "上传视频时自动抠封面帧"
chk admin/admin.js "SHRINK_LADDER"     "图片按体积压缩"
chk admin/admin.js "slot: 'front'"     "三个固定上传位（信封正面/反面/投递视频）"

# ---------- 汇总 ----------
note ""
if [ "$FAIL" = "0" ]; then
  note "✅ 巡检通过：后端活着、前端指着对的地方、页面能开、该有的功能都在。"
else
  note "⚠️ 上面有 ❌ —— 客户的订单管道可能已经出问题了。"
  note "   下一步：打开 WorkBuddy，找「订单同步系统巡检」那条记录，让它做深度检查与修复。"
fi
exit "$FAIL"
