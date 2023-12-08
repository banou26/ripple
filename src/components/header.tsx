import { torrentCollection, type TorrentDocument } from '../database'

import { css } from '@emotion/react'
import { ChartConfiguration } from 'chart.js'
import { Line } from 'react-chartjs-2'

import { useRxCollection, useRxQuery } from 'rxdb-hooks'
import { getHumanReadableByteString } from '../utils/bytes'
import Modal from './modal'
import { useEffect, useState } from 'react'
import { Settings } from 'react-feather'

const style = css`
  display: grid;
  grid-template-columns: minmax(0, 2fr) 1fr;
  height: 100%;
  width: 100%;
  overflow: hidden;
  gap: 2.5rem;

  .chart-wrapper {
    height: 100%;
    width: 100%;
  }

  .side {
    display: grid;
    grid-template-columns: auto 5rem;
    gap: 1rem;

    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr 1fr;
      gap: 1rem;
      padding: 1.5rem;

      div {
        display: flex;
        flex-direction: column;
        justify-content: center;
        text-align: center;
        font-size: 1.25rem;
        color: #fff;
        text-align: left;

        .value {
          font-size: 1.5rem;
          font-weight: 600;
        }

        .label {
          font-size: 1.25rem;
          color: #aaa;
          font-weight: 600;
          text-transform: uppercase;
          white-space: nowrap;
        }
      }
    }
  }

  button {
    display: flex;
    height: 4.5rem;
    padding: 1.5rem 1.5rem;
    border-radius: 0.5rem;
    border: none;
    background-color: rgb(24, 26, 27);
    cursor: pointer;

    display: flex;
    align-items: center;
    justify-content: center;
    gap: .25rem;

    font-weight: bold;
    color: #aaa;

    svg {
      width: 1.5rem;
      height: 1.5rem;
      stroke-width: 3;
    }

    &.active {
      background-color: #2f2f2f;
      color: #fff;
    }
  }

  .settings-button {
    margin: 0 auto;
  }

`

const modalStyle = css`

.title {
  font-size: 2.2rem;
  font-weight: bold;
}

.body {
  display: grid;
  grid-template-columns: 1fr;
  gap: 2.5rem;
  padding: 1.5rem;

  .section {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;

    .title {
      font-size: 2rem;
      font-weight: bold;
    }

    & > .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      align-items: center;

      &.multi {
        grid-template-columns: 1fr;
      }

      .label {
        display: flex;
        justify-content: space-between;
      }

      input[type="text"] {
        height: 3rem;
        padding: 1rem;
        border-radius: 0.5rem;
        border: none;
        background-color: rgb(24, 26, 27);
        color: #aaa;
      }

      input[type="checkbox"] {
        height: 1.5rem;
        width: 1.5rem;
        border-radius: 0.25rem;
        border: none;
        background-color: rgb(24, 26, 27);
      }

      button {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: .25rem;
        font-weight: bold;
        color: #aaa;
        background-color: rgb(24, 26, 27);
        border: none;
        border-radius: 0.5rem;
        padding: 1rem 1.5rem;
        cursor: pointer;
        margin-left: auto;

        svg {
          width: 1.5rem;
          height: 1.5rem;
          stroke-width: 3;
        }

        &.active {
          background-color: #2f2f2f;
          color: #fff;
        }
      }
    }

    .label {
      font-weight: 500;
    }

    .value {
      text-align: right;
      font-weight: 300;
    }
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
  const [peakDownloadSpeed, setPeakDownloadSpeed] = useState(0)

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

  const dataPoints = [...new Array(20 - latestDataPoints.length).fill(undefined), ...latestDataPoints]

  const currentDownloadSpeed =
    allTorrents
      ?.map(torrent => torrent.state.downloadSpeed ?? 0)
      .reduce((acc, curr) => acc + curr, 0)

  useEffect(() => {
    if (currentDownloadSpeed > peakDownloadSpeed) {
      setPeakDownloadSpeed(currentDownloadSpeed)
    }
  }, [currentDownloadSpeed])

  // delete all IDB instances
  const resetIdb = async () => {
    await torrentCollection.bulkRemove(allTorrents.map(torrent => torrent.infoHash))
    indexedDB.deleteDatabase('rxdb-dexie-ripple--0--_rxdb_internal')
    indexedDB.deleteDatabase('rxdb-dexie-ripple--0--settings')
    indexedDB.deleteDatabase('rxdb-dexie-ripple--0--torrents')
    await resetOPFS()
    location.reload()
  }

  const deleteTorrents = async () => {
    await torrentCollection.bulkRemove(allTorrents.map(torrent => torrent.infoHash))
    await resetOPFS()
  }

  const resetOPFS = async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('torrents')
    const iterator = directory.entries()
    const nextEntry = async () => {
      const { done, value } = await iterator.next()
      if (!value) return
      const [filePath] = value
      await (directory as FileSystemDirectoryHandle).removeEntry(filePath, { recursive: true })
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

  const [isModalOpen, setIsModalOpen] = useState(false)

  const onOpen = () => {
    setIsModalOpen(true)
  }

  const onClose = () => {
    setIsModalOpen(false)
  }

  return (
    <div css={style} {...rest}>
      <Modal open={isModalOpen} css={modalStyle} onClose={onClose}>
        <div className="header">
          <div className="title">Settings</div>
        </div>
        <div className="main">
          <div className="content">
            <div className="body">
              <div className="section">
                <div className="title">Bandwidth</div>
                <div className="row multi">
                  <label className="label">
                    <span>Limit download speed</span>
                    <input type="checkbox" className="value"/>
                  </label>
                  <label className="label">
                    <span>Enter download speed limit in KB/s</span>
                    <input type="text" className="value"/>
                  </label>
                </div>
              </div>
              <div className="section">
                <div className="title">Queuing</div>
                <div className="row">
                  <div className="label">Maximum active downloads</div>
                  <div className="value">Unlimited</div>
                </div>
                <div className="row">
                  <div className="label">Download other when watching</div>
                  <div className="value">Unlimited</div>
                </div>
              </div>
              <div className="section">
                <div className="title">Data</div>
                <div className="row">
                  <div className="label">Clear all data</div>
                  <div className="value">
                    <button onClick={resetIdb}>RESET APP</button>
                  </div>
                </div>
                <div className="row">
                  <div className="label">Clear torrents</div>
                  <div className="value">
                    <button onClick={deleteTorrents}>DELETE ALL TORRENTS</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Modal>
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
                  label: (context) => `${context.dataset.label} ${getHumanReadableByteString(context.parsed.y, true)}/s`
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
      <div className='side'>
        <div className='stats'>
          <div className='stat'>
            <div className='value'>{getHumanReadableByteString(currentDownloadSpeed, true)}/s</div>
            <div className='label'>Current</div>
          </div>
          <div className='stat'>
            <div className='value'>{getHumanReadableByteString(peakDownloadSpeed, true)}/s</div>
            <div className='label'>Peak</div>
          </div>
          <div className='stat'>
            <div className='value'>0 MB</div>
            <div className='label'>Total</div>
          </div>
          <div className='stat'>
            <div className='value'>0 MB/s</div>
            <div className='label'>Disk usage</div>
          </div>
        </div>
        {/* <button onClick={resetIdb}>reset IDB</button>
        <button onClick={resetOPFS}>reset OPFS</button> */}
        <button className='settings-button' onClick={onOpen}>
          <Settings/>
        </button>
      </div>
    </div>
  )
}

export default StatisticsHeader
