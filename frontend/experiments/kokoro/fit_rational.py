"""Monotonic bounded rational-quadratic fit to original Kokoro WPM."""
import json
from pathlib import Path
import numpy as np
from scipy.optimize import least_squares
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import plotly.graph_objects as go

OUT = Path(__file__).resolve().parent / 'output-surface'


def rational(p, maximum, half_saturation):
    return maximum * np.asarray(p)**2 / (half_saturation**2 + np.asarray(p)**2)


def fit(p, y):
    result = least_squares(lambda params: rational(p, *params) - y,
                           [max(y)*1.1, 1.0], bounds=([1, 1e-6], [5000, 50]),
                           max_nfev=10000, ftol=1e-12, xtol=1e-12, gtol=1e-12)
    if not result.success:
        raise RuntimeError(result.message)
    return result.x


def main():
    rows = [json.loads(path.read_text()) for path in sorted(OUT.glob('point-*.json'))]
    p = np.array([r['pacing'] for r in rows])
    y = np.array([r['originalWpm'] for r in rows])
    c = np.array([r['compression'] for r in rows])
    observed = np.array([r['wpm'] for r in rows])
    params = fit(p,y)
    maximum, half = params
    prediction = rational(p,*params)
    loo, quadratic_loo = [], []
    for i in range(len(p)):
        keep = np.arange(len(p)) != i
        loo.append(float(rational(p[i], *fit(p[keep],y[keep]))))
        quadratic_loo.append(float(np.polynomial.polynomial.polyval(p[i],
                             np.polynomial.polynomial.polyfit(p[keep],y[keep],2))))
    loo = np.array(loo)
    report = dict(points=[r['point'] for r in rows],
                  formula='WPM(p,c) = c * M * p^2 / (K^2 + p^2)',
                  M=float(maximum), K=float(half), KSquared=float(half**2),
                  pacingRange=[float(p.min()),float(p.max())],
                  compressionRange=[float(c.min()),float(c.max())],
                  trainRmse=float(np.sqrt(np.mean((prediction-y)**2))),
                  leaveOneOutRmse=float(np.sqrt(np.mean((loo-y)**2))),
                  quadraticLeaveOneOutRmse=float(np.sqrt(np.mean((np.array(quadratic_loo)-y)**2))),
                  rSquared=float(1-np.sum((prediction-y)**2)/np.sum((y-y.mean())**2)),
                  combinedLeaveOneOutRmse=float(np.sqrt(np.mean((c*loo-observed)**2))),
                  constraints='M>0, K>0; f(0)=0; f is increasing for p>0 and bounded above by M',
                  caveat='M is a fitted asymptote, not a measured or validated physical maximum. Predictions beyond measured pacing are extrapolation. Single speech and voice.',
                  measurements=[dict(point=r['point'], pacing=r['pacing'], originalWpm=r['originalWpm'],
                                     fittedWpm=float(v), heldOutWpm=float(h)) for r,v,h in zip(rows,prediction,loo)])
    (OUT/'rational-fit.json').write_text(json.dumps(report,indent=2)+'\n')
    grid=np.linspace(p.min(),p.max(),200)
    extended=np.linspace(p.max(),10,200)
    fig, axes=plt.subplots(1,2,figsize=(12,5))
    quadratic=np.polynomial.polynomial.polyfit(p,y,2)
    axes[0].scatter(p,y,color='black',label='10 full-speech measurements',zorder=5)
    axes[0].plot(grid,rational(grid,*params),label='Bounded rational quadratic')
    axes[0].plot(grid,np.polynomial.polynomial.polyval(grid,quadratic),'--',label='Ordinary quadratic')
    axes[0].set(xlabel='Kokoro pacing (×)',ylabel='WPM before compression',title='Fit within measured range')
    axes[0].legend(fontsize=8)
    axes[1].scatter(p,y,color='black',zorder=5)
    axes[1].plot(grid,rational(grid,*params),label='Fit over measured pacing')
    axes[1].plot(extended,rational(extended,*params),'--',label='Extrapolation (unvalidated)')
    axes[1].axhline(maximum,color='gray',linestyle=':',label=f'Fitted asymptote: {maximum:.1f} WPM')
    axes[1].set(xlabel='Kokoro pacing (×)',ylabel='WPM before compression',title='Monotonic approach to a finite limit')
    axes[1].legend(fontsize=8)
    fig.suptitle('WPM(p,c) ≈ c × M p² / (K² + p²)')
    fig.tight_layout()
    fig.savefig(OUT/'rational-fit.png',dpi=170)
    plt.close(fig)
    pp,cc=np.meshgrid(grid,np.linspace(c.min(),c.max(),100))
    chart=go.Figure([go.Surface(x=pp,y=cc,z=cc*rational(pp,*params),colorscale='Viridis',opacity=.8),
                    go.Scatter3d(x=p,y=c,z=observed,mode='markers',marker=dict(color='red',size=5),name='Measured')])
    chart.update_layout(title='Bounded rational quadratic × compression',
                        scene=dict(xaxis_title='Kokoro pacing ×',yaxis_title='Compression ×',zaxis_title='WPM'))
    chart.write_html(OUT/'rational-surface.html',include_plotlyjs=True)
    print(json.dumps({k:v for k,v in report.items() if k!='measurements'},indent=2))


if __name__ == '__main__':
    main()
