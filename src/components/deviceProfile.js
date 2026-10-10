// 默认尺寸仅供布局，不能作为实际设备尺寸上报。
function createDeviceProfile(device, target) {
  const listeners = []
  let settled = false
  target.screenShape = "pill-shaped"
  target.isPillShaped = true
  target.deviceType = "band"
  target.screenSize = {width: 192, height: 490}
  target.deviceInfoReady = false
  target.deviceDimensionsKnown = false
  target.deviceInfoStatus = "loading"
  function subscribe(handler) {
    listeners.push(handler)
    return () => {
      const index = listeners.indexOf(handler)
      if (index >= 0) listeners.splice(index, 1)
    }
  }
  function finish(data) {
    if (settled) return
    settled = true
    const info = data || {}
    const shape = info.screenShape === "rect" || info.screenShape === "circle" ? info.screenShape : "pill-shaped"
    const validSize = Number.isInteger(info.screenWidth) && info.screenWidth > 0 && info.screenWidth <= 4096 &&
      Number.isInteger(info.screenHeight) && info.screenHeight > 0 && info.screenHeight <= 4096
    target.screenShape = shape
    target.isPillShaped = shape === "pill-shaped"
    target.deviceType = info.deviceType === "watch" || info.deviceType === "band" ? info.deviceType : shape === "circle" ? "watch" : "band"
    const fallback = shape === "circle" ? {width: 480, height: 480} : shape === "rect"
      ? target.deviceType === "watch" ? {width: 320, height: 385} : {width: 336, height: 480}
      : {width: 192, height: 490}
    target.screenSize = validSize ? {width: info.screenWidth, height: info.screenHeight} : fallback
    target.deviceDimensionsKnown = validSize
    target.deviceInfoReady = true
    target.deviceInfoStatus = data ? "ready" : "failed"
    listeners.slice().forEach(handler => handler())
  }
  try { device.getInfo({success: finish, fail: () => finish(null)}) } catch (e) { finish(null) }
  return {subscribe}
}

export default {createDeviceProfile}
