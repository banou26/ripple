import { css } from '@emotion/react'
import { Line } from 'react-chartjs-2'

const style = css`

  .chart-wrapper {
    height: 100%;
  }

`


const DATA_COUNT = 11;
const labels = [];
for (let i = 0; i < DATA_COUNT; ++i) {
  labels.push(i.toString());
}
const datapoints = [0, 20, 20, 60, 60, 120, 180, 120, 125, 105, 110, 170];
const data = {
  labels: labels,
  datasets: [
    {
      label: 'Cubic interpolation (monotone)',
      data: datapoints,
      borderColor: '#eb4034',
      fill: false,
      cubicInterpolationMode: 'monotone',
      tension: 0.4
    }, {
      label: 'Cubic interpolation',
      data: datapoints,
      borderColor: '#34eb40',
      fill: false,
      tension: 0.4
    }, {
      label: 'Linear interpolation (default)',
      data: datapoints,
      borderColor: '#4034eb',
      fill: false
    }
  ]
}

const config = {
  type: 'line',
  data: data,
  options: {
    responsive: true,
    plugins: {
      title: {
        display: false,
        text: 'Chart.js Line Chart - Cubic interpolation mode'
      },
      legend: {
        display: false
      }
    },
    interaction: {
      intersect: false,
    },
    scales: {
      x: {
        display: false,
        title: {
          display: false
        }
      },
      y: {
        display: false,
        title: {
          display: false,
          text: 'Value'
        },
        suggestedMin: 0,
        suggestedMax: 200
      }
    }
  },
}

// Should have 1 line for every second, and 120 lines total
// mixed chart with custom tooltip example: https://stackoverflow.com/a/46343907
export const StatisticsHeader = ({ ...rest }) => {

  // delete all IDB instances
  const resetIdb = () => {
    indexedDB.deleteDatabase('rxdb-dexie-ripple--0--_rxdb_internal')
    indexedDB.deleteDatabase('rxdb-dexie-ripple--0--torrents')
  }

  const resetOPFS = async () => {
    const directory = await navigator.storage.getDirectory()
    const iterator = directory.entries()
    const nextEntry = async () => {
      const { done, value } = await iterator.next()
      if (!value) return
      const [filePath, handle] = value
      await (handle as FileSystemDirectoryHandle).removeEntry(filePath, { recursive: true })
      if (done) return
      nextEntry()
    }
    nextEntry()
  }


  return (
    <div css={style} {...rest}>
      <div className="chart-wrapper">
        <Line
          data={data}
          options={{
            ...config.options,
            plugins: {
              ...config.options.plugins,
              tooltip: {
                backgroundColor: '#4f4f4f',
                displayColors: false,
                animation: {
                  duration: 0
                }
              }
            },
            interaction: {
              mode: 'index',
              axis: 'x',
              intersect: false
            }
          }}
        />
      <button onClick={resetIdb}>reset IDB</button>
      <button onClick={resetOPFS}>reset OPFS</button>
      </div>
    </div>
  )
}

export default StatisticsHeader
