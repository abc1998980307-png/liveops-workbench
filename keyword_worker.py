"""Offline Chinese KeyBERT analysis; launched as one bounded subprocess."""
import argparse
import os
import re
import signal
from collections import Counter
from pathlib import Path

# Imports below must never fetch a model or send telemetry during analysis.
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
                  TOKENIZERS_PARALLELISM='false', OMP_NUM_THREADS='2', MKL_NUM_THREADS='2')
from keyword_service import corpus, save_json, stamp, MAX_REFERENCES
from platform_support import file_lock

STOP = frozenset('大家 这个 那个 一些 一下 时候 什么 怎么 现在 今天 明天 昨天 我们 你们 他们 自己 这样 那样 因为 所以 但是 然后 一个 两个 这边 那边 里面 外面 朋友 同学 好的 没有 可以 不是 就是 需要 进行 真的 已经 还是 还有'.split())


def candidates(units):
    import jieba
    import jieba.posseg as posseg
    jieba.setLogLevel(30)
    for word in ('自然拼读', '直播间', '转化率', '千川', '短视频', '客单价'):
        jieba.add_word(word, tag='n')
    counts = Counter()
    for unit in units:
        previous = ''
        for token in posseg.cut(unit['text'], HMM=False):
            word = token.word.casefold()
            valid = 2 <= len(word) <= 16 and word not in STOP and (token.flag in ('n', 'nr', 'ns', 'nt', 'nz', 'eng')) and re.fullmatch(r'[\u3400-\u9fffA-Za-z][\u3400-\u9fffA-Za-z0-9_-]+', word)
            if valid:
                counts[word] += 1
                phrase = previous + word
                if previous and len(phrase) <= 10:
                    counts[phrase] += 1
                previous = word
            else:
                previous = ''
    return counts


def extract(data_root, model=None):
    import numpy as np
    import torch
    from keybert import KeyBERT
    from sentence_transformers import SentenceTransformer
    from sklearn.feature_extraction.text import CountVectorizer

    torch.set_num_threads(2)
    data = corpus(data_root / 'transcripts')
    documents = data.pop('documents')
    units = [dict(unit, file=doc['file'], account=doc['account'], sourceUrl=doc['sourceUrl']) for doc in documents for unit in doc['units']]
    result = dict(data, mode='keybert', generatedAt=stamp(), keywords=[], model='paraphrase-multilingual-MiniLM-L12-v2',
                  note='语义分数为本机语料与候选词的余弦相似度，可能为负值；不表示搜索量、准确率或成交意向。')
    if not units:
        return result
    print('正在进行中文分词…', flush=True)
    counts = candidates(units)
    eligible = [word for word, count in counts.most_common() if count >= (2 if len(units) > 100 else 1)]
    vocabulary = eligible[:3000]
    result['candidateLimitReached'] = len(eligible) > len(vocabulary)
    result['candidatesConsidered'] = len(vocabulary)
    if not vocabulary:
        return result
    print('正在加载本地语义模型…', flush=True)
    encoder = SentenceTransformer(str(model or data_root / 'tools/keyword-model'), device='cpu', local_files_only=True)
    # Analyze all selected text in tokenizer-sized chunks.  Encode each unique
    # chunk once, retaining its original frequency in the pooled document vector.
    chunks = Counter()
    width = max(8, int(encoder.max_seq_length) - 10)
    for document in documents:
        pending = []
        for unit in document['units']:
            tokens = encoder.tokenizer.encode(unit['text'], add_special_tokens=False, truncation=False, verbose=False)
            pending.extend(tokens)
            while len(pending) >= width:
                chunk = encoder.tokenizer.decode(pending[:width], skip_special_tokens=True)
                chunks[chunk] += 1
                pending = pending[width:]
        if pending:
            chunks[encoder.tokenizer.decode(pending, skip_special_tokens=True)] += 1
    if not chunks:
        return result
    print(f'正在分析 {len(documents)} 份语料、{len(chunks)} 个文本片段…', flush=True)
    embeddings = encoder.encode(list(chunks), batch_size=32, show_progress_bar=False, normalize_embeddings=True)
    doc_embedding = np.average(embeddings, axis=0, weights=list(chunks.values())).reshape(1, -1)
    word_embeddings = encoder.encode(vocabulary, batch_size=32, show_progress_bar=False, normalize_embeddings=True)
    scores = word_embeddings @ (doc_embedding[0] / max(np.linalg.norm(doc_embedding[0]), 1e-12))
    shortlist = sorted(np.argsort(-scores)[:200], key=lambda index: vocabulary[index])
    terms = [vocabulary[index] for index in shortlist]
    word_embeddings = word_embeddings[shortlist]
    # The analyzer supplies the vetted terms already observed in this corpus.
    # KeyBERT performs semantic ranking and MMR on bounded, aligned embeddings.
    vectorizer = CountVectorizer(analyzer=lambda _text: terms, vocabulary=terms)
    pairs = KeyBERT(model=encoder).extract_keywords('local corpus', vectorizer=vectorizer,
                    doc_embeddings=doc_embedding, word_embeddings=word_embeddings,
                    use_mmr=True, diversity=0.35, top_n=min(50, len(terms)))
    for term, score in pairs:
        refs, count, files = [], 0, set()
        for unit in units:
            text = unit['text']
            found = list(re.finditer(re.escape(term), text, re.IGNORECASE))
            if not found:
                continue
            count += len(found)
            files.add(unit['file'])
            if len(refs) < MAX_REFERENCES:
                offset = found[0].start()
                begin, end = max(0, offset - 55), min(len(text), offset + len(term) + 125)
                refs.append({key: unit[key] for key in ('file', 'account', 'sourceUrl', 'timestamp', 'seconds')})
                refs[-1]['text'] = ('…' if begin else '') + text[begin:end] + ('…' if end < len(text) else '')
        if refs:
            result['keywords'].append({'term': term, 'score': float(score), 'count': count,
                                       'documents': len(files), 'references': refs})
    result['chunksAnalyzed'] = sum(chunks.values())
    result['uniqueChunks'] = len(chunks)
    print(f'分析完成：{len(result["keywords"])} 个关键词', flush=True)
    return result


def main():
    if hasattr(signal, 'SIGALRM'):
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('关键词分析超过十分钟，可缩小语料范围后重试')))
        signal.alarm(600)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--model', type=Path)
    args = parser.parse_args()
    root = args.data_root.expanduser().resolve()
    (root / 'keywords').mkdir(parents=True, exist_ok=True)
    with file_lock(root / 'keywords/analysis.lock'):
        result = extract(root, args.model)
        save_json(root / 'keywords/result.json', result)


if __name__ == '__main__':
    main()
