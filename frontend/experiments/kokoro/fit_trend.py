"""Fit WPM(pacing, compression) = compression * polynomial(pacing).

Reads completed point JSON directly; safe to run while the benchmark continues.
"""
import json
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import plotly.graph_objects as go

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output-surface'


def main():
    rows = [json.loads(p.read_text()) for p in sorted(OUT.glob('point-*.json'))]
    x = np.array([r['pacing'] for r in rows])
    c = np.array([r['compression'] for r in rows])
    y = np.array([r['originalWpm'] for r in rows])
    z = np.array([r['wpm'] for r in rows])
    fits = []
    for degree in (1, 2, 3):
        coeff = np.polynomial.polynomial.polyfit(x, y, degree)
        prediction = np.polynomial.polynomial.polyval(x, coeff)
        cv = []
        for i in range(len(x)):
            keep = np.arange(len(x)) != i
            cc = np.polynomial.polynomial.polyfit(x[keep], y[keep], degree)
            cv.append(np.polynomial.polynomial.polyval(x[i], cc))
        fits.append(dict(degree=degree, coefficientsAscending=coeff.tolist(),
                         trainRmse=float(np.sqrt(np.mean((prediction-y)**2))),
                         leaveOneOutRmse=float(np.sqrt(np.mean((np.array(cv)-y)**2))),
                         rSquared=float(1-np.sum((prediction-y)**2)/np.sum((y-y.mean())**2))))
    best = min(fits, key=lambda f:f['leaveOneOutRmse'])
    expected = c*y
    multiplier = float(expected@z/(expected@expected))
    deviation = z/expected-1
    report = dict(completedPoints=[r['point'] for r in rows],
                  formula='WPM(p,c) ≈ c * sum(a[k] * p**k)',
                  pacingRange=[float(x.min()),float(x.max())],
                  compressionRange=[float(c.min()),float(c.max())],
                  compressionMultiplierFit=multiplier,
                  compressionMaxRelativeDeviation=float(abs(deviation).max()),
                  polynomials=fits, selected=best,
                  caveat='Provisional single speech/voice fit. Leave-one-out error is not a confidence interval. No extrapolation; polynomials do not enforce a physical saturation limit.')
    (OUT/'polynomial-fit.json').write_text(json.dumps(report,indent=2)+'\n')
    xx = np.linspace(x.min(),x.max(),200)
    fig,axes = plt.subplots(1,2,figsize=(12,5))
    axes[0].scatter(x,y,color='black',label=f'{len(rows)} full-speech measurements',zorder=5)
    for f in fits:
        axes[0].plot(xx,np.polynomial.polynomial.polyval(xx,f['coefficientsAscending']),
                     label=f"Degree {f['degree']}: LOO RMSE {f['leaveOneOutRmse']:.1f} WPM")
    axes[0].set(xlabel='Kokoro phoneme pacing (×)',ylabel='WPM before compression',title='Kokoro pacing: polynomial fits')
    axes[0].legend(fontsize=8)
    axes[1].scatter(c,z/y,color='black')
    axes[1].plot([c.min(),c.max()],[c.min(),c.max()],'--',label='Exact multiplicative response')
    axes[1].set(xlabel='Requested compression (×)',ylabel='Measured WPM multiplier',title='Compression: nearly multiplicative')
    axes[1].legend(fontsize=8)
    fig.suptitle(f'Provisional trend from {len(rows)} completed points; no extrapolation')
    fig.tight_layout()
    fig.savefig(OUT/'polynomial-fit.png',dpi=170)
    plt.close(fig)
    pp,cc = np.meshgrid(xx,np.linspace(c.min(),c.max(),100))
    zz = cc*np.polynomial.polynomial.polyval(pp,best['coefficientsAscending'])
    chart = go.Figure([go.Surface(x=pp,y=cc,z=zz,colorscale='Viridis',opacity=.8),
                      go.Scatter3d(x=x,y=c,z=z,mode='markers',marker=dict(color='red',size=5),name='Measured')])
    chart.update_layout(title=f'Polynomial × compression: {len(rows)} points, provisional degree {best["degree"]}',
                        scene=dict(xaxis_title='Kokoro pacing ×',yaxis_title='Compression ×',zaxis_title='WPM'))
    chart.write_html(OUT/'polynomial-surface.html',include_plotlyjs=True)
    print(json.dumps(report,indent=2))


if __name__ == '__main__':
    main()
