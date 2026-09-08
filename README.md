# Ticket Price Radar Collector

这是“票价雷达”的 MoreTickets 数据采集器。

它会读取票价雷达网站中已经添加的监测链接，抓取演出名称、场次日期、场馆、市场最低价、门票数量和各票档价格，并把结果传回共享网站数据库。

## 自动运行

GitHub Actions 每两小时运行一次，也可以在仓库的 Actions 页面手动运行。

## 文件说明

- `collector/scrape_moretickets.py`：MoreTickets 抓取程序
- `collector/requirements.txt`：Python 依赖
- `.github/workflows/scrape.yml`：每两小时自动运行配置

## 网站

https://ticket-price-radar-cn.memonrial.chatgpt.site
