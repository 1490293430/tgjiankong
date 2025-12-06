from pymongo import MongoClient

def ensure_indexes():
    client = MongoClient("mongodb://mongo:27017/tglogs")  # ← 你的 Mongo 地址
    db = client.tglogs
    logs = db.logs

    print("🔧 正在检查 / 创建 MongoDB 索引...")

    logs.create_index([("time", -1)])
    logs.create_index([("channelId", 1)])
    logs.create_index([("messageId", 1)])
    logs.create_index([("keywords", 1)])

    print("✅ MongoDB 索引已全部准备完成")

if __name__ == "__main__":
    ensure_indexes()
