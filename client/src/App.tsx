
import React, { useRef, useState } from 'react'
// Use the ESM build provided by pdfjs-dist for Vite bundling
import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs'
// Import the worker file from the package build
// Import worker as a URL so Vite copies it to the build and returns a path
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker
import 'pdfjs-dist/web/pdf_viewer.css'

export default function App() {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [colorCount, setColorCount] = useState<number>(0)
  const [processing, setProcessing] = useState(false)
  const [colorFlags, setColorFlags] = useState<boolean[]>([])
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  // server analysis not used — perform client-side analysis for responsiveness
  const [pricingMode, setPricingMode] = useState<'per-side' | 'per-sheet'>('per-side')
  const [step, setStep] = useState<'upload' | 'summary'>('upload')
  // User preference: auto = use detected; color = force color; bw = force black & white
  const [printPreference, setPrintPreference] = useState<'auto' | 'color' | 'bw'>('auto')
  const [dragActive, setDragActive] = useState(false)

  function onSelectClick() {
    if (!processing) inputRef.current?.click()
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragActive(true)
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setDragActive(false)
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragActive(false)
    const f = e.dataTransfer.files && e.dataTransfer.files[0]
    if (f) {
      setFile(f)
      const url = URL.createObjectURL(f)
      setPreviewUrl(url)
      if (f.type === 'application/pdf') processPdf(f)
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files && e.target.files[0]
    if (f) {
      setFile(f)
      const url = URL.createObjectURL(f)
      setPreviewUrl(url)
      if (f.type === 'application/pdf') {
        processPdf(f)
      }
    }
  }

  async function processPdf(f: File) {
    setProcessing(true)
    setThumbnail(null)
    try {
      const data = await f.arrayBuffer()
      const loadingTask = pdfjsLib.getDocument({ data })
      const doc = await loadingTask.promise
      const n = doc.numPages
      setPageCount(n)

      const flags: boolean[] = []
      // Process all pages for higher accuracy
      for (let i = 1; i <= n; i++) {
        const page = await doc.getPage(i)
        // render at modest scale for performance
        const v = page.getViewport({ scale: 1 })
        const canvas = document.createElement('canvas')
        const maxDim = 800
        const scale = Math.max(1, Math.min(2, maxDim / v.width))
        const vp = page.getViewport({ scale })
        canvas.width = Math.floor(vp.width)
        canvas.height = Math.floor(vp.height)
        const ctx = canvas.getContext('2d')!
        await page.render({ canvasContext: ctx, viewport: vp }).promise

        if (i === 1) {
          setThumbnail(canvas.toDataURL('image/png'))
        }

        const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
        flags.push(detectColorImageData(img))
      }

      const colorPages = flags.filter(Boolean).length
      setColorFlags(flags)
      setColorCount(colorPages)
    } catch (err) {
      console.error('PDF processing failed', err)
      setPageCount(null)
      setColorCount(0)
      setColorFlags([])
    } finally {
      setProcessing(false)
    }
  }

  async function uploadForServerAnalysis(f: File) {
    setProcessing(true)
    setThumbnail(null)
    try {
      const fd = new FormData()
      fd.append('file', f)
      const res = await fetch('/api/analyze', { method: 'POST', body: fd })
      const body = await res.json()
      if (body && body.pageCount != null) {
        setPageCount(body.pageCount)
        setColorCount(body.colorCount || 0)
        setColorFlags(body.colorFlags || [])
        if (body.thumbnail) setThumbnail(body.thumbnail)
      }
    } catch (err) {
      console.error('Server analysis failed', err)
    } finally {
      setProcessing(false)
    }
  }

  function detectColorImageData(img: ImageData) {
    const data = img.data
    // denser sampling for higher accuracy
    const step = 4
    let coloredSamples = 0
    let totalSamples = 0
    for (let i = 0; i < data.length; i += 4 * step) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      totalSamples++
      if (Math.abs(r - g) > 12 || Math.abs(r - b) > 12 || Math.abs(g - b) > 12) coloredSamples++
    }
    // consider page color if > 3% sampled pixels are colored
    return totalSamples > 0 && (coloredSamples / totalSamples) > 0.03
  }

  function onRemove() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(null)
    setPreviewUrl(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  // When user confirms upload, navigate to summary page to show totals and price
  function onConfirm() {
    if (!file) {
      alert('Please select a file to continue')
      return
    }
    // if still processing, inform user to wait
    if (processing) {
      alert('Processing document — please wait a moment')
      return
    }
    setStep('summary')
  }

  // preserve print for later, but not used in the upload step
  function onPrint() {
    if (!file) return
    const url = previewUrl || URL.createObjectURL(file)
    const iframe = document.createElement('iframe')
    iframe.style.position = 'fixed'
    iframe.style.right = '0'
    iframe.style.bottom = '0'
    iframe.style.width = '0'
    iframe.style.height = '0'
    iframe.style.border = '0'
    iframe.src = url
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus()
        iframe.contentWindow?.print()
      } catch (err) {
        window.open(url)
      }
      setTimeout(() => {
        document.body.removeChild(iframe)
        if (!previewUrl) URL.revokeObjectURL(url)
      }, 1000)
    }
    document.body.appendChild(iframe)
  }

  const effectiveColorCount = printPreference === 'auto' ? (colorCount || 0) : printPreference === 'color' ? (pageCount || 0) : 0
  const bwPages = pageCount ? Math.max(0, pageCount - effectiveColorCount) : 0

  function computeTotals() {
    if (!pageCount) return { total: 0, breakdown: [] }
    if (pricingMode === 'per-side') {
      const bwPrice = bwPages * 5
      const colorPrice = effectiveColorCount * 10
      return { total: bwPrice + colorPrice, breakdown: [{ label: 'B/W', count: bwPages, pricePer: 5 }, { label: 'Color', count: colorCount || 0, pricePer: 10 }] }
    }

    // per-sheet: group pages into sheets of two sides
    const flags = colorFlags.length === pageCount ? colorFlags : Array.from({ length: pageCount }, (_, i) => i < (colorCount || 0))
    let total = 0
    const sheets: Array<{ sides: number; colorSides: number; price: number }> = []
    for (let i = 0; i < pageCount; i += 2) {
      const side1Color = !!flags[i]
      const side2Color = !!flags[i + 1]
      const colorSides = (side1Color ? 1 : 0) + (side2Color ? 1 : 0)
      // if last sheet has only one side
      const sidesInSheet = i + 1 < pageCount ? 2 : 1
      const bwSides = sidesInSheet - colorSides
      const price = colorSides * 10 + bwSides * 5
      sheets.push({ sides: sidesInSheet, colorSides, price })
      total += price
    }
    return { total, breakdown: sheets }
  }

  const totals = computeTotals()
  const total = totals.total

  async function createOrderAndPay() {
    if (!pageCount) {
      alert('No document processed')
      return
    }
    const payload = { amount: total, meta: { pageCount, colorCount, pricingMode, colorFlags } }
    const res = await fetch('/api/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const body = await res.json()
    if (body.simulated) {
      const ok = confirm(`Simulated payment for Rs ${total}. Proceed to print now?`)
      if (ok) {
        // mark order complete on server
        try {
          await fetch(`/api/order/${body.order.id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payment: { simulated: true } }) })
        } catch (e) {}
        showToast('Payment successful — printing started')
        onShowPrintModal()
        setTimeout(() => onPrint(), 800)
      }
      return
    }

    const options = {
      key: body.key || '',
      amount: body.order.amount,
      currency: body.order.currency,
      name: 'Metalix Print',
      order_id: body.order.id,
      handler: function (response: any) {
        alert('Payment completed')
        // start printing after successful payment
        try {
          onPrint()
        } catch (err) {
          console.error('print after payment failed', err)
        }
      }
    }

    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.onload = () => {
      // @ts-ignore
      const rzp = new window.Razorpay(options)
      rzp.open()
    }
    document.body.appendChild(s)
  }

  // Toast
  const [toast, setToast] = useState<string | null>(null)
  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }

  // Print modal and options
  const [printModalOpen, setPrintModalOpen] = useState(false)
  const [copies, setCopies] = useState(1)
  const [duplex, setDuplex] = useState(pricingMode === 'per-sheet')
  function onShowPrintModal() {
    setPrintModalOpen(true)
  }
  function onClosePrintModal() {
    setPrintModalOpen(false)
  }

  function onPrintWithOptions() {
    // note: browser print dialogs control duplex/copies; we only collect options for server records
    onClosePrintModal()
    onPrint()
  }

  return (
    <div className="app-wrap">
      <header className="app-header">
        <img
          src="/logo.png"
          alt="Logo"
          className="logo"
          onError={(e) => {
            const t = e.currentTarget as HTMLImageElement
            if (!t.src.endsWith('/logo.svg')) t.src = '/logo.svg'
          }}
        />
        <div>
          <h1>Metalix Print</h1>
          <p className="subtitle">Upload • Print • Deliver</p>
        </div>
      </header>

      <main className="card">
        {processing && (
          <div className="processing-overlay">
            <div className="spinner" />
            <div className="processing-text">Analyzing document…</div>
          </div>
        )}
        {step === 'upload' ? (
          <div>
            <div className={`file-area ${dragActive ? 'drag-over' : ''}`} onClick={onSelectClick} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,image/*"
                onChange={onFileChange}
                style={{ display: 'none' }}
              />

              {thumbnail ? (
                <img src={thumbnail} alt="thumb" style={{ width: 140, height: 180, objectFit: 'cover', borderRadius: 8 }} />
              ) : file && file.type.startsWith('image/') && previewUrl ? (
                <img src={previewUrl} alt="preview" style={{ width: 140, height: 180, objectFit: 'contain', borderRadius: 8 }} />
              ) : file ? (
                <div className="file-info">
                  <div className="file-icon">📄</div>
                  <div className="file-meta">
                    <div className="file-name">{file.name}</div>
                    <div className="file-size">{(file.size / 1024).toFixed(1)} KB</div>
                  </div>
                </div>
              ) : (
                <div className="empty" style={{ padding: 40, textAlign: 'center', cursor: 'pointer' }} onClick={onSelectClick}>
                  <div style={{ width: 96, height: 96, margin: '0 auto 14px', borderRadius: 48, background: '#fff', boxShadow: '0 8px 20px rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
                      <path d="M12 16V6" stroke="#f97316" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M8 10l4-4 4 4" stroke="#f97316" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M21 16v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2" stroke="#f97316" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#111827' }}>Drop your PDF here</div>
                  <div style={{ marginTop: 8, color: '#6b7280' }}>or <span style={{ color: '#f97316', textDecoration: 'underline' }}>click to browse</span> — we'll count pages and detect color automatically</div>
                </div>
              )}

              <div className="actions">
                <button className="btn" onClick={onSelectClick} disabled={processing}>
                  Choose File
                </button>
                <button className="btn ghost" onClick={onRemove} disabled={processing}>
                  Remove
                </button>
              </div>
              <div style={{ width: '100%', marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="radio" name="pricing" checked={pricingMode === 'per-side'} onChange={() => setPricingMode('per-side')} /> Per-side
                  </label>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="radio" name="pricing" checked={pricingMode === 'per-sheet'} onChange={() => setPricingMode('per-sheet')} /> Per-sheet (duplex)
                  </label>
                </div>
              </div>
            </div>

                <div style={{ marginTop: 12 }}>
                <div>Pages: {pageCount ?? '-'}</div>
                <div>Detected color pages: {colorCount}</div>
                <div>Print mode:
                <div>Color pages (estimated): {colorCount}</div>
                                <div>Print mode:
                                  <label style={{ marginLeft: 8, marginRight: 8 }}><input type="radio" name="printMode" checked={printPreference === 'auto'} onChange={() => setPrintPreference('auto')} /> Auto</label>
                                  <label style={{ marginRight: 8 }}><input type="radio" name="printMode" checked={printPreference === 'color'} onChange={() => setPrintPreference('color')} /> Force Color</label>
                                  <label><input type="radio" name="printMode" checked={printPreference === 'bw'} onChange={() => setPrintPreference('bw')} /> Force B/W</label>
                                </div>
                                <div>Final color pages (after selection): {effectiveColorCount}</div>
                                <div>Black & White pages: {bwPages}</div>
                                <div style={{ marginTop: 8, color: '#6b7280' }}>Estimated total updates automatically based on selection</div>
                <div style={{ marginTop: 8, fontWeight: 700 }}>Estimated total: Rs {total}</div>
                <div style={{ marginTop: 10 }}>
                  <button className="btn primary" onClick={onConfirm} disabled={!file || processing}>
                    Confirm
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              {thumbnail && <img src={thumbnail} alt="thumb" style={{ width: 180, height: 230, objectFit: 'cover', borderRadius: 8 }} />}
              <div>
                <h2 style={{ margin: 0 }}>{file?.name}</h2>
                <div style={{ marginTop: 8 }}>Pages: {pageCount}</div>
                <div>Color pages: {colorCount}</div>
                <div>B/W pages: {bwPages}</div>
                <div style={{ marginTop: 8, fontWeight: 700 }}>Total: Rs {total}</div>
              </div>
            </div>

            <div style={{ marginTop: 18 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Would you like to proceed?</div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    className="btn primary"
                    onClick={async () => {
                      await createOrderAndPay()
                    }}
                    disabled={!pageCount || processing}
                  >
                    Yes — Pay
                  </button>
                  <button className="btn ghost" onClick={() => setStep('upload')}>
                    No — Go back
                  </button>
                </div>
            </div>
          </div>
        )}
      </main>

      {toast && (
        <div className="toast">{toast}</div>
      )}

      {printModalOpen && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Print Preview & Options</h3>
            {thumbnail && <img src={thumbnail} alt="thumb" style={{ width: 220, borderRadius: 8 }} />}
            <div style={{ marginTop: 12 }}>
              <label style={{ display: 'block', marginBottom: 8 }}>Copies: <input type="number" min={1} value={copies} onChange={(e) => setCopies(Number(e.target.value) || 1)} style={{ width: 60, marginLeft: 8 }} /></label>
              <label style={{ display: 'block', marginBottom: 8 }}><input type="checkbox" checked={duplex} onChange={(e) => setDuplex(e.target.checked)} /> Duplex (per-sheet)</label>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <button className="btn primary" onClick={onPrintWithOptions}>Print Now</button>
              <button className="btn ghost" onClick={onClosePrintModal}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
