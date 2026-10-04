#!/usr/bin/env bash
# ============================================================
#  云端哨兵「自己」的体检 —— 跑在 GitHub 服务器上
# ============================================================
#
# 为什么需要这个文件：
#
#   patrol.sh 检查的是**线上订单管道**（后端活着吗、页面能开吗、收款码在吗）。
#   但它有个盲区：**它自己会不会按时跑，它查不了。**
#
#   工作流的失效方式是**静默地不再响** —— 不跑就开不了 Issue、发不了邮件，
#   所以「哨兵死了」这个事实永远不会有人告诉你。
#
#   这个文件补上的就是这一环：让哨兵每次跑的时候，
#   顺便报告「上一次我是什么时候跑的、迟了多久」。
#   这样一旦它开始漏跑，Issue 里 / 日志里立刻能看出来。
#
# 同时验证一件必须验证的事：
#   **这个工作流的定时到底被注册上了没有。**
#   手动触发成功 ≠ 定时能跑，两者是完全不同的触发路径。
#   实测踩过：state=active、手动跑 3 次全绿、schedule 次数 = 0。
#
# 判定分级（避免误报成灾）：
#   · 从没跑过 schedule + 工作流建了不到 12 小时 → 提示，不算故障
#     （GitHub 对新建工作流的第一次定时不保证注册上，是已知行为）
#   · 从没跑过 schedule + 工作流建了超过 12 小时 → 报警（报出去，要人管）
#   · 上次 schedule 至今超过 2 倍 cron 周期 + 宽限 → 报警
#
# 退出码：0 = 正常；1 = 有问题（会让整个工作流变红 → 开单 + 发邮件）

set -uo pipefail

REPO="${GITHUB_REPOSITORY:-DwaiLoveLYT/artist-letter}"
WORKFLOW_FILE="patrol.yml"     # 用文件名，不写死数字 id —— 重建后 id 会变
CRON_HOURS=6                   # 与 patrol.yml 的 cron 保持一致
GRACE_HOURS=2                  # 允许的延迟余量（GitHub 高峰期约 1 小时）
NEW_WF_HOURS=12                # 建了不到这么多小时，不把「没触发过」算故障

TOKEN="${GH_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "ⓘ 没有 GH_TOKEN，跳过云端哨兵自检（不算故障）"
  exit 0
fi

api() {
  curl -sS -H "Authorization: Bearer $TOKEN" \
       -H "Accept: application/vnd.github+json" \
       -H "X-GitHub-Api-Version: 2022-11-28" \
       -H "User-Agent: artist-letter-selfcheck" \
       --max-time 30 --retry 2 --retry-delay 3 \
       "https://api.github.com$1" 2>/dev/null
}

now_utc() { date -u '+%Y-%m-%d %H:%M:%S UTC'; }
now_epoch() { date -u '+%s'; }

to_epoch() { # ISO8601 → epoch
  date -u -d "$1" '+%s' 2>/dev/null || echo 0
}

echo "云端哨兵自检：$(now_utc)"
echo "  仓库：$REPO"

bad=0
note() { echo "  ⓘ $1"; }
ok()   { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; bad=1; }

# ── ① 工作流还在不在、有没有被停掉 ──────────────────────────
wf_json="$(api "/repos/$REPO/actions/workflows")"
wf_state="$(printf '%s' "$wf_json" | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print('PARSE_FAIL'); raise SystemExit
for w in d.get('workflows',[]):
    if w.get('path','').endswith('/$WORKFLOW_FILE'):
        print(w.get('state','?')); break
else: print('MISSING')
" 2>/dev/null || echo QUERY_FAIL)"

case "$wf_state" in
  active)  ok "工作流 $WORKFLOW_FILE 存在且是 active" ;;
  MISSING) fail "仓库里找不到 $WORKFLOW_FILE —— 云端哨兵整个没了" ;;
  PARSE_FAIL|QUERY_FAIL) note "查工作流状态失败（可能是网络抖动），这一条跳过不判" ;;
  *)       fail "工作流状态是 $wf_state，不是 active —— 去仓库 Actions 页点 Enable workflow" ;;
esac

# ── ② 定时到底有没有真的触发过（核心）───────────────────────
runs="$(api "/repos/$REPO/actions/workflows/$WORKFLOW_FILE/runs?per_page=50")"
summary="$(printf '%s' "$runs" | python3 -c "
import sys,json,datetime
try: d=json.load(sys.stdin)
except Exception: print('PARSE_FAIL'); raise SystemExit
rs = d.get('workflow_runs') or []
sch = [r for r in rs if r.get('event')=='schedule']
man = [r for r in rs if r.get('event')=='workflow_dispatch']
def age(iso):
    t = datetime.datetime.strptime(iso,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
    return (datetime.datetime.now(datetime.timezone.utc)-t).total_seconds()/3600.0
first_created = min([age(r['created_at']) for r in rs], default=None)
if sch:
    a = age(sch[0]['created_at'])
    print('HAS|%.2f|%s|%d|%d' % (a, sch[0].get('conclusion'), len(sch), len(man)))
else:
    # 字段顺序与 HAS 保持一致（5 段），否则下面的 read 会把数字读错位
    print('NONE|%.2f||0|%d' % (first_created if first_created is not None else -1, len(man)))
" 2>/dev/null || echo 'QUERY_FAIL')"

case "$summary" in
  HAS\|*)
    IFS='|' read -r _ ago concl nsch nman <<< "$summary"
    limit="$(python3 -c "print($CRON_HOURS + $GRACE_HOURS)")"
    late="$(python3 -c "print(1 if $ago > $limit else 0)")"
    if [ "$late" = "1" ]; then
      fail "上次定时触发距今 ${ago} 小时，超过 $CRON_HOURS 小时周期 + $GRACE_HOURS 小时宽限 —— 哨兵可能已经开始漏跑"
    elif [ "$concl" != "success" ]; then
      fail "上次定时触发的结果是 $concl，不是 success —— 去看运行记录"
    else
      ok "定时在正常触发（最近一次 ${ago} 小时前，成功；累计定时 $nsch 次 / 手动 $nman 次）"
    fi
    ;;
  NONE\|*)
    IFS='|' read -r _ age nconcl nsch nman <<< "$summary"
    if [ "$age" = "-1" ]; then
      note "运行记录为空（工作流可能刚建），这一条跳过不判"
    else
      too_new="$(python3 -c "print(1 if $age < $NEW_WF_HOURS else 0)")"
      if [ "$too_new" = "1" ]; then
        note "定时还没触发过（手动 $nman 次），但工作流建了才 ${age} 小时 —— GitHub 对新建工作流的第一次定时不保证注册上，下轮再确认"
      else
        fail "定时一次都没有触发过（手动 $nman 次，工作流已建 ${age} 小时）—— 早就该触发了，定时很可能没被注册上"
      fi
    fi
    ;;
  *) note "查运行记录失败，这一条跳过不判" ;;
esac

echo ""
if [ "$bad" = "0" ]; then
  echo "✅ 云端哨兵自检通过"
else
  echo "❌ 云端哨兵自检未通过 —— 哨兵本身可能已经不可靠了"
fi
exit "$bad"
