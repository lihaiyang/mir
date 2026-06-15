import { webFrame } from 'electron'

// Patch navigator.serviceWorker.register in the page's main world to handle
// Electron webview's transient "document is in an invalid state" race.
// Injected via webFrame so it runs in the page's main world even with
// contextIsolation enabled, and executes before any page script.
const patchCode = `(function () {
  if (window.__mirSwPatched) return
  window.__mirSwPatched = true
  if (!('serviceWorker' in navigator)) return

  var sw = navigator.serviceWorker
  var origRegister = sw.register.bind(sw)

  function isInvalidState(err) {
    if (!err) return false
    if (err.name === 'InvalidStateError') return true
    var m = err.message || ''
    return m.toLowerCase().indexOf('invalid state') !== -1
  }

  function waitForActive() {
    return new Promise(function (resolve) {
      function settle() { requestAnimationFrame(function () { resolve() }) }
      if (document.readyState === 'complete') return settle()
      window.addEventListener('load', settle, { once: true })
    })
  }

  sw.register = function (url, opts) {
    var attempt = 0
    var delays = [100, 300, 800, 1500]
    function tryOnce() {
      return origRegister(url, opts).catch(function (err) {
        if (!isInvalidState(err) || attempt >= delays.length) throw err
        var delay = delays[attempt++]
        return waitForActive()
          .then(function () { return new Promise(function (r) { setTimeout(r, delay) }) })
          .then(tryOnce)
      })
    }
    return tryOnce()
  }
})()`

webFrame.executeJavaScript(patchCode).catch(() => {})
