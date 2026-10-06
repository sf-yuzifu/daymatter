// 应用级 interconnect 单例连接的唯一持有者与消息分发层。
// 单例连接只安装一个 onmessage（dispatch），本身不持有任何页面对象；
// 页面通过 subscribeMessage / unsubscribeMessage 订阅与解除，
// 销毁时解除订阅，避免旧页面 this 被单例连接长期引用。

let conn = null
let messageHandler = null

function dispatch(event) {
  const handler = messageHandler
  if (handler) {
    handler(event)
  }
}

// 获取单例连接；首次调用时安装唯一的消息分发器。
// 无 interconnect 能力或实例获取失败时返回 null。
function getConnection(interconnectModule) {
  if (conn) return conn
  if (!interconnectModule || typeof interconnectModule.instance !== "function") return null
  try {
    conn = interconnectModule.instance()
  } catch (e) {
    return null
  }
  if (conn) {
    conn.onmessage = dispatch
  }
  return conn
}

// 页面订阅消息：后订阅者生效；解除时只清理仍属自己的处理器
function subscribeMessage(handler) {
  messageHandler = handler
}

function unsubscribeMessage(handler) {
  if (messageHandler === handler) {
    messageHandler = null
  }
}

export default {
  getConnection,
  subscribeMessage,
  unsubscribeMessage
}
