from pymongo import MongoClient

def ensure_indexes():
    # 静默连接，不输出日志
    client = MongoClient("mongodb://mongo:27017/tglogs", serverSelectionTimeoutMS=5000)
    db = client.tglogs
    logs = db.logs

    # 静默创建索引，不输出日志

    # 基础索引
    logs.create_index([("time", -1)])
    logs.create_index([("channelId", 1)])
    logs.create_index([("messageId", 1)])
    logs.create_index([("keywords", 1)])
    
    # 重要：添加 ai_analyzed 索引，避免 countDocuments({ ai_analyzed: false }) 查询慢
    logs.create_index([("ai_analyzed", 1)])
    
    # 重要：添加 alerted 索引，避免 countDocuments({ alerted: true }) 查询慢
    logs.create_index([("alerted", 1)])
    
    # 复合索引优化常见查询
    logs.create_index([("time", -1), ("ai_analyzed", 1)])  # 用于查找未分析的消息按时间排序
    logs.create_index([("channelId", 1), ("time", -1)])   # 用于按频道查询

    # 静默完成，不输出日志

if __name__ == "__main__":
    ensure_indexes()
