//! The refinement worker (addendum V-7.3): one thread that owns the Qwen3-ASR recognizer and
//! rewrites one segment at a time, in the order they were submitted. The model loads on the
//! first job, so turning enhancement on never delays the streaming recognizer. A job whose
//! session ended or whose deadline passed is skipped; a decode already running cannot be
//! interrupted, its result is simply ignored.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::thread::JoinHandle;
use std::time::Instant;

use crate::models::EnhancedModelPaths;
use crate::recognizer::{Qwen, Refine};
use crate::session::REFINE_QUEUE;

/// A finished (or skipped) refinement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refined {
    /// The session generation the job belonged to.
    pub generation: u64,
    /// Segment.
    pub segment: u64,
    /// The text, or `Err` when the model failed or the job was skipped.
    pub result: Result<String, ()>,
}

struct Job {
    generation: u64,
    segment: u64,
    pcm: Vec<f32>,
    deadline: Instant,
}

/// The worker thread and its queues.
pub struct RefineWorker {
    jobs: Option<SyncSender<Job>>,
    done: Receiver<Refined>,
    current: Arc<AtomicU64>,
    thread: Option<JoinHandle<()>>,
    context: String,
}

/// Builds the refiner on the worker thread.
pub type RefinerFactory = Box<dyn FnOnce() -> Option<Box<dyn Refine>> + Send>;

impl RefineWorker {
    /// Starts a worker that loads Qwen3-ASR from `paths` with `context` words on first use.
    #[must_use]
    pub fn spawn_qwen(paths: EnhancedModelPaths, threads: i32, context: String) -> Self {
        let words = context.clone();
        Self::spawn(
            Box::new(move || {
                Qwen::load(&paths, threads, &words)
                    .ok()
                    .map(|q| Box::new(q) as Box<dyn Refine>)
            }),
            context,
        )
    }

    /// Starts a worker with any refiner (tests).
    #[must_use]
    pub fn spawn(factory: RefinerFactory, context: String) -> Self {
        let (jobs, inbox) = mpsc::sync_channel::<Job>(REFINE_QUEUE);
        let (outbox, done) = mpsc::channel();
        let current = Arc::new(AtomicU64::new(0));
        let thread = {
            let current = Arc::clone(&current);
            std::thread::Builder::new()
                .name("piarc-speech-refine".to_owned())
                .spawn(move || work(factory, &inbox, &outbox, &current))
                .ok()
        };
        Self {
            jobs: Some(jobs),
            done,
            current,
            thread,
            context,
        }
    }

    /// The context words it was built with.
    #[must_use]
    pub fn context(&self) -> &str {
        &self.context
    }

    /// Marks `generation` as the live session; jobs of other generations are skipped.
    pub fn set_generation(&self, generation: u64) {
        self.current.store(generation, Ordering::Relaxed);
    }

    /// Queues a segment; `false` when the queue is full or the worker is gone.
    pub fn submit(&self, generation: u64, segment: u64, pcm: Vec<f32>, deadline: Instant) -> bool {
        let Some(jobs) = &self.jobs else {
            return false;
        };
        match jobs.try_send(Job {
            generation,
            segment,
            pcm,
            deadline,
        }) {
            Ok(()) => true,
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => false,
        }
    }

    /// Results ready now.
    pub fn poll(&self) -> Vec<Refined> {
        let mut out = Vec::new();
        loop {
            match self.done.try_recv() {
                Ok(refined) => out.push(refined),
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => return out,
            }
        }
    }

    /// Stops the worker and waits for it (at most the decode in progress).
    pub fn shutdown(mut self) {
        self.current.store(u64::MAX, Ordering::Relaxed);
        self.jobs = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for RefineWorker {
    fn drop(&mut self) {
        // Dropping the sender ends the worker after its current job; it frees the model.
        self.current.store(u64::MAX, Ordering::Relaxed);
        self.jobs = None;
    }
}

fn work(
    factory: RefinerFactory,
    inbox: &Receiver<Job>,
    outbox: &mpsc::Sender<Refined>,
    current: &AtomicU64,
) {
    let mut factory = Some(factory);
    let mut refiner: Option<Box<dyn Refine>> = None;
    while let Ok(job) = inbox.recv() {
        let live =
            current.load(Ordering::Relaxed) == job.generation && Instant::now() < job.deadline;
        let result = if live {
            if refiner.is_none() {
                refiner = factory.take().and_then(|make| make());
            }
            refiner
                .as_mut()
                .map_or(Err(()), |r| r.refine(&job.pcm).map_err(|_| ()))
        } else {
            Err(())
        };
        if outbox
            .send(Refined {
                generation: job.generation,
                segment: job.segment,
                result,
            })
            .is_err()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::error::SpeechError;

    struct Echo;

    impl Refine for Echo {
        fn refine(&mut self, pcm: &[f32]) -> Result<String, SpeechError> {
            Ok(format!("{} samples", pcm.len()))
        }
    }

    fn wait(worker: &RefineWorker, count: usize) -> Vec<Refined> {
        let mut out = Vec::new();
        for _ in 0..200 {
            out.extend(worker.poll());
            if out.len() >= count {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        out
    }

    #[test]
    fn jobs_come_back_in_order() {
        let worker = RefineWorker::spawn(
            Box::new(|| Some(Box::new(Echo) as Box<dyn Refine>)),
            String::new(),
        );
        worker.set_generation(1);
        let deadline = Instant::now() + Duration::from_secs(5);
        assert!(worker.submit(1, 0, vec![0.0; 3], deadline));
        assert!(worker.submit(1, 1, vec![0.0; 5], deadline));
        let results = wait(&worker, 2);
        assert_eq!(
            results,
            vec![
                Refined {
                    generation: 1,
                    segment: 0,
                    result: Ok("3 samples".into())
                },
                Refined {
                    generation: 1,
                    segment: 1,
                    result: Ok("5 samples".into())
                },
            ]
        );
        worker.shutdown();
    }

    #[test]
    fn stale_and_late_jobs_are_skipped() {
        let worker = RefineWorker::spawn(
            Box::new(|| Some(Box::new(Echo) as Box<dyn Refine>)),
            String::new(),
        );
        worker.set_generation(2);
        assert!(worker.submit(1, 0, vec![0.0], Instant::now() + Duration::from_secs(5)));
        assert!(worker.submit(2, 1, vec![0.0], Instant::now()));
        let results = wait(&worker, 2);
        assert!(results.iter().all(|r| r.result.is_err()), "{results:?}");
    }

    #[test]
    fn a_refiner_that_cannot_load_fails_each_job() {
        let worker = RefineWorker::spawn(Box::new(|| None), String::new());
        worker.set_generation(1);
        assert!(worker.submit(1, 0, vec![0.0], Instant::now() + Duration::from_secs(5)));
        assert_eq!(wait(&worker, 1)[0].result, Err(()));
    }
}
