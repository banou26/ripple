import { type TorrentDocument } from '../database'

import { css } from '@emotion/react'
import { ChartConfiguration } from 'chart.js'
import { Line } from 'react-chartjs-2'

import { useRxCollection, useRxQuery } from 'rxdb-hooks'
import { getHumanReadableByteString } from '../utils/bytes'

const style = css`

  .chart-wrapper {
    height: 100%;
    width: 100%;

    canvas {
      height: 100%;
      width: 100%;
    }
  }

`

const config: ChartConfiguration = {
  type: 'line',
  options: {
    maintainAspectRatio: false,
    responsive: true,
    animation: {
      duration: 0
    },
    plugins: {
      title: {
        display: false,
        text: 'Download statistics'
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
  const collection = useRxCollection<TorrentDocument>('torrents')
  const allTorrentsQuery = collection?.find({})
  const { result: allTorrents } = useRxQuery(allTorrentsQuery)

  console.log('header allTorrents', allTorrents)

  const allDataPoints =
    allTorrents
      ?.map(torrent => torrent.state.streamBandwithLogs)
      .flat()
      .map((log) => ({
        x: Math.floor(log.timestamp / 1000),
        y: log.byteLength
      }))
      .reduce((acc, curr) => {
        const index = acc.findIndex((log) => log.x === curr.x)
        if (index === -1) {
          acc.push(curr)
        } else {
          acc[index].y += curr.y
        }
        return acc
      }, [])
      .sort((a, b) => a.x - b.x)
    ?? []


  const latestDataPoints =
    allDataPoints
      .filter((log) => log.x > allDataPoints.at(-1).x - 120)
      .slice(-20)
      .slice(0, -1)

  console.log('latestDataPoints', latestDataPoints)

  const dataPoints = [...new Array(20 - latestDataPoints.length).fill(undefined), ...latestDataPoints]

  console.log('dataPoints', dataPoints)

  // delete all IDB instances
  const resetIdb = () => {
    indexedDB.deleteDatabase('rxdb-dexie-ripple--0--_rxdb_internal')
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

  const data = {
    labels: dataPoints.map((log) => log && new Date(log.x).toLocaleTimeString()),
    datasets: [
      // {
      //   label: 'Cubic interpolation (monotone)',
      //   data: dataPoints.map((log) => log?.y),
      //   borderColor: '#eb4034',
      //   fill: false,
      //   cubicInterpolationMode: 'monotone',
      //   tension: 0.4
      // },
      // {
      //   label: 'Cubic interpolation',
      //   data: dataPoints.map((log) => log?.y),
      //   borderColor: '#34eb40',
      //   fill: false,
      //   tension: 0.4
      // },
      {
        label: 'Network',
        data: dataPoints.map((log) => log?.y),
        borderColor: '#4034eb',
        fill: false
      }
    ]
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
                },
                callbacks: {
                  label: (context) => `${context.dataset.label} ${getHumanReadableByteString(context.parsed.y)}/s`
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
      </div>
      <div>
        <button onClick={resetIdb}>reset IDB</button>
        <button onClick={resetOPFS}>reset OPFS</button>
      </div>
    </div>
  )
}

export default StatisticsHeader
