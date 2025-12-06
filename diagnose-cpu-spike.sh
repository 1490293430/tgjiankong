#!/bin/bash
# CPU峰值诊断脚本
# 用于定位28秒左右CPU峰值的原因

echo "=========================================="
echo "CPU峰值诊断工具"
echo "=========================================="
echo ""

echo "1. 检查所有容器的CPU使用情况..."
docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}"
echo ""

echo "2. 检查Telethon容器的日志（查找性能监控信息）..."
echo "--- 配置重载任务 ---"
docker-compose logs telethon --tail 100 | grep -E "\[性能监控\]|配置重载|config_reloader" | tail -20
echo ""

echo "3. 检查API容器的日志（查找性能监控信息）..."
echo "--- 统计接口查询 ---"
docker-compose logs api --tail 100 | grep -E "\[性能监控\]|/api/stats|/api/ai/stats|checkMessageCountTrigger" | tail -20
echo ""

echo "4. 检查MongoDB容器的日志..."
docker-compose logs mongo --tail 50 | tail -20
echo ""

echo "5. 检查所有定时任务和间隔设置..."
echo "--- 配置重载间隔: 10秒 ---"
echo "--- Web界面刷新间隔: 30秒 ---"
echo "--- MongoDB健康检查: 30秒 ---"
echo "--- AI计数检查: 60秒 ---"
echo ""

echo "6. 实时监控CPU使用（按Ctrl+C停止）..."
echo "开始监控，观察28秒左右的CPU峰值..."
docker stats --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}" | head -20

