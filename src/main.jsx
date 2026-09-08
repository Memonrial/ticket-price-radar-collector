import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('票价雷达页面加载失败', error)
  }

  render() {
    if (this.state.error) {
      return (
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f5f6f8', color: '#30343a' }}>
          <section style={{ maxWidth: 520, padding: 28, border: '1px solid #e7e9ed', borderRadius: 16, background: '#fff', textAlign: 'center' }}>
            <h1 style={{ margin: '0 0 10px', fontSize: 22 }}>票价雷达暂时无法显示</h1>
            <p style={{ margin: '0 0 18px', color: '#747b85', lineHeight: 1.7 }}>页面数据没有丢失。请刷新一次；如果仍然出现此提示，请把本页截图发给管理员。</p>
            <button onClick={() => window.location.reload()} style={{ padding: '10px 18px', border: 0, borderRadius: 9, background: '#25282e', color: '#fff' }}>重新加载</button>
          </section>
        </main>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>,
)
