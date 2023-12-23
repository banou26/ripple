import { useSettingsDocument, type TorrentDocument, removeTorrent, torrentCollection, supportsFSA, setSaveFolderHandle } from '../database'

import { serverProxyFetch } from '@fkn/lib'
import { css } from '@emotion/react'
import { useEffect, useState } from 'react'
import { RxDocument } from 'rxdb'
import { Download, Upload, ArrowDownCircle, Pause, Play, X, ArrowDown, ArrowUp } from 'react-feather'
import { Link } from 'react-router-dom'

import { getHumanReadableByteString } from '../utils/bytes'
import { addTorrentFile } from '../utils/add-torrent'
import { playableVideoFileExtensions } from '../utils/file-type'
import Modal from './modal'

const style = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;

  width: 100%;

  .category {
    width: 100%;
    height: 100%;

    & > .title {
      display: flex;
      align-items: center;

      gap: 1rem;
      font-size: 2rem;
      font-weight: bold;
      width: 100%;
      height: 4rem;
      padding: 1rem;
      border-bottom-color: rgb(48, 52, 54);
      background-color: rgb(35, 38, 40);
      /* border-bottom: 1px solid #fff;
      background-color: #2f2f2f; */

      span {
        display: flex;
        align-items: center;
        gap: .5rem;
      }

      .fsa-action {
        margin-left: 2rem;
        display: flex;
        align-items: center;
        gap: .5rem;

        button {
          padding: .5rem;
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
      }
    }

    .items {
      display: flex;
      flex-direction: column;
      gap: .25rem;
      padding: .5rem .1rem;
      padding-bottom: 1rem;
    }
    
    .select-file {
      max-width: 40rem;
      margin: auto;
      padding: 1rem;
      overflow: hidden;

      border-bottom-color: rgb(48, 52, 54);
      background-color: rgb(35, 38, 40);
      /* border-bottom: 1px solid #fff;
      background-color: #2f2f2f; */
      border-radius: .5rem;
      border: .25rem solid rgb(48, 52, 54);
      border-style: dashed;
      margin-top: 2rem;

      display: flex;
      font-size: 1.5rem;
      font-weight: bold;
      color: #aaa;
      text-align: center;

      cursor: pointer;
    }

    .item {
      /* display: grid;
      grid-template-columns: minmax(100rem, 4fr) minmax(min-content, 35rem) minmax(max-content, 10rem);
      grid-template-areas: "main info actions"; */


      width: 100%;
      border-bottom-color: rgb(48, 52, 54);
      background-color: rgb(35, 38, 40);
      /* border-bottom: 1px solid #fff;
      background-color: #2f2f2f; */
      border: 1px solid rgb(48, 52, 54);
      padding: 1rem;

      .highlight {
        color: #fff;
      }


      /* &:nth-of-type(-n+2) {
        border-top: 1px solid rgb(48, 52, 54);
      } */

      /* :last-child {
        border-bottom: none;
      } */
      
      /* &:hover {
        background-color: rgb(48, 52, 54);
      } */

      .files {
        display: flex;
        flex-direction: column;
        gap: .25rem;
        padding: .5rem .1rem;
        padding-bottom: 1rem;

        .file {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding: .5rem 0;
          border-bottom: 1px solid rgb(48, 52, 54);

          .name {
            font-size: 1.5rem;
            font-weight: bold;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .size {
            color: #aaa;
            font-weight: bold;
          }

          .play {
            margin-left: auto;
            display: flex;
            align-items: center;
            gap: .5rem;

            button {
              padding: 1rem;
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
          }
        }
      }

      .main {
        display: grid;
        grid-template-columns: minmax(100rem, 4fr) minmax(min-content, 35rem) minmax(max-content, 10rem);
        grid-template-areas: "main info actions";
        height: 12rem;

        /* display: flex;
        gap: 2rem; */
      }

      &.finished .main {
        grid-template-columns: minmax(100rem, 4fr) minmax(min-content, 0rem) minmax(max-content, 10rem);
      }

      .info {
        display: flex;
        /* padding: 1rem; */
        gap: 2rem;

        .preview {
          height: 10rem;
          width: calc(10rem * calc(16 / 9));
          background-color: #0f0f0f;
          object-fit: contain;
        }

        .content {
          display: flex;
          flex-direction: column;
          max-width: 75%;

          .toggle-show-files {
            display: flex;
            align-items: center;
            gap: .5rem;
            font-size: 1.5rem;
            font-weight: bold;
            color: #aaa;
            background-color: transparent;
            border: none;
            cursor: pointer;

            svg {
              stroke-width: 3;
            }

            &:hover {
              color: #fff;
            }
          }

          .name {
            font-size: 2rem;
            font-weight: bold;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .size {
            margin-top: 1rem;
            color: #aaa;
            font-weight: bold;
          }

          .sources {
            display: flex;

            margin-top: auto;

            button {
              padding: .25rem .5rem;
              margin-right: 0.5rem;
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
          }
        }
      }

      .download-info {
        display: flex;
        margin-left: auto;
        justify-content: center;
        flex-direction: column;
        padding: 2rem;
        gap: .5rem;

        width: 100%;

        font-weight: bold;
        color: #aaa;

        /* svg {
          stroke-width: 3;
        } */


        .progress-title {
          display: flex;
          align-items: center;
          justify-content: space-between;

          .status {
            font-size: 1.5rem;
            font-weight: bold;
            margin-right: 1rem;
            color: #aaa;
          }

          .remaining {
            font-size: 1.5rem;
            font-weight: bold;
            color: #aaa;
          }
        }

        .progress-bar {
          width: 100%;
          height: .25rem;
          margin-bottom: 0.5rem;
          background-color: #3d3d3d;

          .inner {
            height: 100%;
            background-color: #fff;
          }
        }

        .torrent-info {
          display: flex;
          justify-content: space-between;

          .peers {
            display: flex;
            align-items: center;
            gap: 1rem;

            span {
              display: flex;
              align-items: center;
              gap: .5rem;
            }
          }

          .stats {
            display: flex;
            align-items: center;
            gap: 2rem;

            span {
              display: flex;
              align-items: center;
              gap: .5rem;
            }
          }
        }
      }
      .actions {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 1rem;
        padding: 1rem;

        button {
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
      }
    }
  }
`

const modalStyle = css`
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem;
    border-bottom: 1px solid rgb(48, 52, 54);
    background-color: rgb(35, 38, 40);

    .title {
      font-size: 2rem;
      font-weight: bold;
    }
  }

  .main {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
    padding-top: 0;
    padding-bottom: 1rem;
    background-color: rgb(35, 38, 40);

    .content {
      display: flex;
      flex-direction: column;
      gap: 1rem;

      .body {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        padding-top: 1rem;

        .message {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          gap: .5rem;
          font-size: 1.7rem;
          font-weight: bold;
          color: #aaa;
        }

        .actions {
          display: flex;
          align-items: center;
          justify-content: space-around;
          gap: 1rem;

          button {
            padding: 1.5rem 1.5rem;
            border-radius: 0.5rem;
            border: none;
            background-color: rgb(24, 26, 27);
            cursor: pointer;

            display: flex;
            align-items: center;
            justify-content: center;
            gap: .25rem;

            width: 100%;

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
        }
      }
    }
  }
`

const getDuckDuckGoToken = async (name: string) => {
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(name)}&iax=images&ia=images`
  const res = await serverProxyFetch(url, {  }).then(res => res.text())
  const result = res.match(/,vqd="(.*?)"/)
  return result[1]
}

const getFirstGoogleImageResult = async (name: string) => {
  const token = await getDuckDuckGoToken(name)
  const res = await serverProxyFetch(`https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(name).replaceAll('-', '%2D')}&vqd=${token}&f=,,,,,&p=1`, {  }).then(res => res.text())
  const dom = new DOMParser().parseFromString(res, 'text/html')
  const results = JSON.parse(dom.body.textContent || '{results:[]}').results
  return results[0].image
}

const rtf = new Intl.RelativeTimeFormat('en', { style: 'short' });

const TorrentItem = ({ torrent }: { torrent: RxDocument<TorrentDocument> }) => {
  const [imgUrl, setImgUrl] = useState<string | undefined>(undefined)
  const [showFiles, setShowFiles] = useState(false)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)

  useEffect(() => {
    getFirstGoogleImageResult(torrent.state.name).then(setImgUrl)
  }, [])

  const remainingTimeString =
    isNaN(torrent.state.remainingTime) || !isFinite(torrent.state.remainingTime)
      ? ''
      : rtf.format(torrent.state.remainingTime ?? 0, 'seconds')

  const remove = () =>
    removeTorrent({
      infoHash: torrent.infoHash,
      removeFiles: true
    })

  const playableFiles = torrent.state.files?.filter((file) => playableVideoFileExtensions.includes(file.name.split('.').pop() ?? ''))

  const showMoreFiles = () => {
    setShowFiles(true)
  }

  const showLessFiles = () => {
    setShowFiles(false)
  }

  const onDeleteModalOpen = () => {
    setIsDeleteModalOpen(true)
  }

  const onDeleteModalClose = () => {
    setIsDeleteModalOpen(false)
  }

  return (
    <div key={torrent.infoHash} className={`item ${torrent.state.status}`}>
      <Modal open={isDeleteModalOpen} css={modalStyle} onClose={onDeleteModalClose}>
        <div className="header">
          <div className="title">Delete torrent ?</div>
        </div>
        <div className="main">
          <div className="content">
            <div className="body">
              <div className="message">
                <span>Are you sure you want to delete </span>
                <span>{torrent.state.name}?</span>
              </div>
              <div className="actions">
                <button onClick={onDeleteModalClose}>Cancel</button>
                <button onClick={remove}>Delete torrent</button>
              </div>
            </div>
          </div>
        </div>
      </Modal>
      <div className="main">
        <div className="info">
          <img className="preview" src={imgUrl} referrerPolicy='no-referrer'/>
          <div className="content">
            <div className="name" title={torrent.state.name}>{torrent.state.name}</div>
            <span className="size">{getHumanReadableByteString(torrent.state.torrentFile.length)}</span>
            <span className="files">
              {
                (torrent.state.files?.length ?? 0) > 1
                  ? `${torrent.state.files?.length} files`
                  : ''
              }
              {
                (torrent.state.files?.length ?? 0) > 1 && (
                  showFiles
                    ? (
                      <button onClick={showLessFiles} className="toggle-show-files">
                        <span>Show less</span>
                        <ArrowUp size={20}/>
                      </button>
                    )
                    : (
                      <button onClick={showMoreFiles} className="toggle-show-files">
                        <span>Show more</span>
                        <ArrowDown size={20}/>
                      </button>
                    )
                )
              }
            </span>
          </div>
        </div>
        <div className="download-info">
          {
            torrent.state.status === 'downloading' && (
              <>
                <div className="progress-title">
                  <span className="status">
                    {
                      torrent.state.status === 'downloading' && `Downloading ${(torrent.state.progress * 100).toFixed(2)}%`
                    }
                    {
                      torrent.state.status === 'finished' && 'Finished'
                    }
                    {
                      torrent.state.status === 'seeding' && 'Seeding'
                    }
                    {
                      torrent.state.status === 'paused' && 'Paused'
                    }
                  </span>
                  <span className="remaining">
                    {
                      torrent.state.status === 'downloading' && (
                        <>
                          <span className="highlight">
                            {remainingTimeString}
                          </span>
                          &nbsp;
                          <span>remaining</span>
                        </>
                      )
                    }
                  </span>
                </div>
                <div className="progress-bar">
                  <div className="inner" style={{ width: `${torrent.state.progress * 100}%`, height: '100%', backgroundColor: '#fff' }} />
                </div>
                <div className="torrent-info">
                  <div className="stats">
                    <span>
                      <ArrowDownCircle size={20}/>
                      <span className="highlight">{getHumanReadableByteString(torrent.state.downloadSpeed ?? 0)}/s</span>
                    </span>
                    <span>
                      <Download size={22}/>
                      <span className="highlight">{getHumanReadableByteString(torrent.state.downloaded ?? 0)}</span>
                      <span>/ {getHumanReadableByteString(torrent.state.torrentFile.length)}</span>
                    </span>
                  </div>
                </div>
              </>
            )
          }
        </div>
        <div className="actions">
          {
            playableFiles?.length ? (
              <Link to={`/watch/${torrent.infoHash}/${playableFiles.at(0)?.index}`} className="play">
                <button>
                  <Play size={20}/>
                </button>
              </Link>
            ) : undefined
          }
          <div>
            <button onClick={onDeleteModalOpen}>
              <X size={20}/>
            </button>
          </div>
        </div>
      </div>
      <div>
        {
          showFiles && (
            <div className="files">
              {
                torrent.state.files?.map((file) => (
                  <div key={file.name} className="file">
                    <span className="name">{file.name}</span>
                    <span className="size">{getHumanReadableByteString(file.length)}</span>
                    {
                      playableVideoFileExtensions.includes(file.name.split('.').pop() ?? '') && (
                        <Link to={`/watch/${torrent.infoHash}/${file.index}`} className="play">
                          <button>
                            <Play size={20}/>
                          </button>
                        </Link>
                      )
                    }
                  </div>
                ))
              }
            </div>
          )
        }
      </div>
    </div>
  )
}

export const TorrentList = ({ ...rest }) => {
  const settings = useSettingsDocument()
  const [allTorrents, setAllTorrents] = useState<RxDocument<TorrentDocument>[]>([])
  useEffect(() => {
    const subscription =
      torrentCollection
        ?.find({})
        .$
        .subscribe((result) => setAllTorrents(result))
    return () => subscription?.unsubscribe()
  }, [])

  const downloadingTorrents =
    allTorrents?.filter(torrent =>
      torrent.state.status === 'init' ||
      torrent.state.status === 'checkingFiles' ||
      torrent.state.status === 'downloadingMetadata' ||
      torrent.state.status === 'downloading' ||
      torrent.state.status === 'paused'
    )
  const completedTorrents =
    allTorrents?.filter(torrent =>
      torrent.state.status === 'finished'
    )
  // console.log('downloadingTorrents', downloadingTorrents)
  // console.log('completedTorrents', completedTorrents)

  const togglePauseAll = async () => {
    await settings?.incrementalModify(doc => {
      doc.paused = !doc.paused
      return doc
    })
  }


  const onSelectFileClick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = () => addTorrentFile([...input.files ?? []])
    input.click()
  }

  const onSelectSaveFolderClick = async () => {
    const handle = await showDirectoryPicker()
    console.log('handle', handle)
    await setSaveFolderHandle(handle)
    await settings?.incrementalModify(doc => {
      doc.saveFolderEnabled = true
      return doc
    })
  }

  return (
    <div css={style} {...rest}>
      <div className="category">
        <div className="title">
          <span>Downloading</span>
          <span onClick={togglePauseAll}>
            {
              settings?.paused ? (
                <Play size={20}/>
              ) : (
                <Pause size={20}/>
              )
            }
          </span>
        </div>
        <div className="items">
          {
            downloadingTorrents?.map(torrent => (
              <TorrentItem
                key={torrent.infoHash}
                torrent={torrent}
              />
            ))
          }
          <div className="select-file" onClick={onSelectFileClick}>
            Click here, drop or paste torrent files or magnets to start downloading
          </div>
        </div>
      </div>
      <div className="category">
        <div className="title">
          <span>Completed</span>
          {/* {
            supportsFSA
              ? (
                <span className="fsa-action">
                  <button onClick={onSelectSaveFolderClick}>Save files in folder</button>
                </span>
              )
              : undefined
          } */}
        </div>
        <div className="items">
          {
            completedTorrents?.map(torrent => (
              <TorrentItem
                key={torrent.infoHash}
                torrent={torrent}
              />
            ))
          }
        </div>
      </div>
    </div>
  )
}

export default TorrentList
