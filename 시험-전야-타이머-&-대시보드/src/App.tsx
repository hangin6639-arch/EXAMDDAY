/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Plus, 
  Trash2, 
  Clock, 
  Calendar, 
  CheckCircle2, 
  Circle, 
  TrendingUp, 
  LayoutDashboard, 
  Timer,
  AlertCircle,
  ChevronRight,
  BookOpen,
  LayoutGrid,
  List,
  Minus
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format, differenceInSeconds, isAfter, parseISO, intervalToDuration, differenceInDays, startOfDay, addHours, addDays } from 'date-fns';
import { ko } from 'date-fns/locale';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { GoogleGenAI, Type } from "@google/genai";

/** Utility for Tailwind class merging */
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Constants ---

const STORAGE_KEY = 'exam-eve-data';
const SLEEP_STORAGE_KEY = 'exam-eve-sleep';

const RISO_SHADES = [
  '#FF4D4D', // Red
  '#2E5BFF', // Blue
  '#FFD23F', // Yellow
  '#33CA7F', // Teal
  '#FF8A5B', // Orange
  '#A663CC', // Purple
  '#FF9FB2', // Pink
  '#000000', // Black
];

const getSubjectColor = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return RISO_SHADES[Math.abs(hash) % RISO_SHADES.length];
};

const formatCountdown = (dateStr: string, now: Date) => {
  const target = parseISO(dateStr);
  const diffSeconds = differenceInSeconds(target, now);
  if (diffSeconds <= 0) return "종료됨";
  
  const totalHours = Math.floor(diffSeconds / 3600);
  const m = Math.floor((diffSeconds % 3600) / 60);
  
  return `${totalHours}h ${m}m`;
};

const formatMinutes = (m: number) => {
  const h = Math.floor(m / 60);
  const mins = m % 60;
  if (h > 0) return `${h}시간 ${mins}분`;
  return `${mins}분`;
};

const formatMinutesShort = (m: number) => {
  const h = Math.floor(m / 60);
  const mins = m % 60;
  if (h > 0) return `${h}h ${mins}m`;
  return `${mins}m`;
};

// --- Types ---

interface Task {
  id: string;
  text: string;
  completed: boolean;
}

interface Subject {
  id: string;
  name: string;
  examDate: string; // ISO string
  allocatedMinutes: number;
  tasks: Task[];
}

interface SleepRange {
  start: string; // "HH:mm"
  end: string;   // "HH:mm"
}

// --- Sub-components ---

export default function App() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [sleepRange, setSleepRange] = useState<SleepRange | null>(null);
  const [isSettingSleep, setIsSettingSleep] = useState(false);
  const [now, setNow] = useState(new Date());
  const [isAdding, setIsAdding] = useState(false);
  const [isAiAdding, setIsAiAdding] = useState(false);
  const [aiInput, setAiInput] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'large' | 'compact'>('large');
  const [timelineMode, setTimelineMode] = useState<'today' | 'all'>('all');
  const [showSleepOnTimeline, setShowSleepOnTimeline] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newSubject, setNewSubject] = useState({ name: '', date: '', time: '' });

  // Initialize data from LocalStorage
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const savedSleep = localStorage.getItem(SLEEP_STORAGE_KEY);
    if (saved) {
      try {
        setSubjects(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to load data', e);
      }
    }
    if (savedSleep) {
      try {
        setSleepRange(JSON.parse(savedSleep));
      } catch (e) {
        setIsSettingSleep(true);
      }
    } else {
      setIsSettingSleep(true);
    }
  }, []);

  // Save to LocalStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(subjects));
  }, [subjects]);

  useEffect(() => {
    if (sleepRange) {
      localStorage.setItem(SLEEP_STORAGE_KEY, JSON.stringify(sleepRange));
    }
  }, [sleepRange]);

  // Update clock
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Calculate earliest exam
  const soonestSubject = useMemo(() => {
    const futureExams = subjects
      .filter(s => isAfter(parseISO(s.examDate), now))
      .sort((a, b) => parseISO(a.examDate).getTime() - parseISO(b.examDate).getTime());
    return futureExams[0] || null;
  }, [subjects, now]);

  // Total available time until first exam (in minutes) excluding sleep
  const totalAvailableMinutes = useMemo(() => {
    if (!soonestSubject || !sleepRange) return 0;
    
    const start = now;
    const end = parseISO(soonestSubject.examDate);
    if (!isAfter(end, start)) return 0;

    let totalMins = differenceInSeconds(end, start) / 60;
    
    // Deduct sleep time blocks
    // We iterate through each day from now until the target date
    let current = new Date(start);
    let sleepDeductionMins = 0;

    const [sH, sM] = sleepRange.start.split(':').map(Number);
    const [eH, eM] = sleepRange.end.split(':').map(Number);

    // Look at each hour between now and target
    const targetTime = end.getTime();
    let tempDate = new Date(start);
    
    // Simple hourly bucket check for easier calculation of sleep overlap
    while (tempDate.getTime() < targetTime) {
      const h = tempDate.getHours();
      const m = tempDate.getMinutes();
      
      // Is current minute within sleep range?
      let isSleeping = false;
      const currentMinutes = h * 60 + m;
      const sleepStartMinutes = sH * 60 + sM;
      const sleepEndMinutes = eH * 60 + eM;

      if (sleepStartMinutes < sleepEndMinutes) {
        // Sleep within same day (e.g. 01:00 to 07:00)
        isSleeping = currentMinutes >= sleepStartMinutes && currentMinutes < sleepEndMinutes;
      } else {
        // Sleep across midnight (e.g. 23:00 to 07:00)
        isSleeping = currentMinutes >= sleepStartMinutes || currentMinutes < sleepEndMinutes;
      }

      if (isSleeping) {
        sleepDeductionMins += 1;
      }
      
      tempDate.setMinutes(tempDate.getMinutes() + 1);
    }

    return Math.max(0, Math.floor(totalMins - sleepDeductionMins));
  }, [soonestSubject, now, sleepRange]);

  // Total allocated time
  const totalAllocatedMinutes = useMemo(() => {
    return subjects.reduce((acc, s) => acc + s.allocatedMinutes, 0);
  }, [subjects]);

  // --- Helpers for Time Calculation ---

  const getAvailableMinutesForRange = (targetDateStr: string) => {
    if (!sleepRange) return 0;
    const start = now;
    const end = parseISO(targetDateStr);
    if (!isAfter(end, start)) return 0;

    let totalMins = differenceInSeconds(end, start) / 60;
    const [sH, sM] = sleepRange.start.split(':').map(Number);
    const [eH, eM] = sleepRange.end.split(':').map(Number);

    const targetTime = end.getTime();
    let tempDate = new Date(start);
    let sleepDeductionMins = 0;
    
    // Minute-by-minute sleep check
    while (tempDate.getTime() < targetTime) {
      const h = tempDate.getHours();
      const m = tempDate.getMinutes();
      let isSleeping = false;
      const currentMinutes = h * 60 + m;
      const sleepStartMinutes = sH * 60 + sM;
      const sleepEndMinutes = eH * 60 + eM;

      if (sleepStartMinutes < sleepEndMinutes) {
        isSleeping = currentMinutes >= sleepStartMinutes && currentMinutes < sleepEndMinutes;
      } else {
        isSleeping = currentMinutes >= sleepStartMinutes || currentMinutes < sleepEndMinutes;
      }

      if (isSleeping) sleepDeductionMins++;
      tempDate.setMinutes(tempDate.getMinutes() + 1);
    }
    return Math.max(0, Math.floor(totalMins - sleepDeductionMins));
  };

  const getSpecificAvailableMinutes = (subject: Subject) => {
    const totalToExam = getAvailableMinutesForRange(subject.examDate);
    const otherAllocated = subjects
      .filter(s => s.id !== subject.id)
      .reduce((acc, s) => acc + s.allocatedMinutes, 0);
    return Math.max(0, totalToExam - otherAllocated);
  };

  const allocationRatio = totalAvailableMinutes > 0 ? (totalAllocatedMinutes / totalAvailableMinutes) * 100 : 0;

  const sortedSubjects = useMemo(() => {
    return [...subjects].sort((a, b) => parseISO(a.examDate).getTime() - parseISO(b.examDate).getTime());
  }, [subjects]);

  // --- Handlers ---

  const addSubject = () => {
    if (!newSubject.name || !newSubject.date || !newSubject.time) return;
    
    const examDate = `${newSubject.date}T${newSubject.time}:00`;
    const newItem: Subject = {
      id: crypto.randomUUID(),
      name: newSubject.name,
      examDate,
      allocatedMinutes: 30, // Default allocation
      tasks: []
    };
    
    setSubjects([...subjects, newItem]);
    setIsAdding(false);
    setNewSubject({ name: '', date: '', time: '' });
  };

  const deleteSubject = (id: string) => {
    setSubjects(subjects.filter(s => s.id !== id));
  };

  const updateAllocation = (id: string, minutes: number) => {
    setSubjects(subjects.map(s => s.id === id ? { ...s, allocatedMinutes: minutes } : s));
  };

  const updateSubjectInfo = (id: string, updates: Partial<Pick<Subject, 'name' | 'examDate'>>) => {
    setSubjects(subjects.map(s => s.id === id ? { ...s, ...updates } : s));
  };

  const addTask = (subjectId: string, text: string) => {
    if (!text.trim()) return;
    setSubjects(subjects.map(s => {
      if (s.id === subjectId) {
        return {
          ...s,
          tasks: [...s.tasks, { id: crypto.randomUUID(), text, completed: false }]
        };
      }
      return s;
    }));
  };

  const toggleTask = (subjectId: string, taskId: string) => {
    setSubjects(subjects.map(s => {
      if (s.id === subjectId) {
        return {
          ...s,
          tasks: s.tasks.map(t => t.id === taskId ? { ...t, completed: !t.completed } : t)
        };
      }
      return s;
    }));
  };

  const deleteTask = (subjectId: string, taskId: string) => {
     setSubjects(subjects.map(s => {
      if (s.id === subjectId) {
        return {
          ...s,
          tasks: s.tasks.filter(t => t.id !== taskId)
        };
      }
      return s;
    }));
  };

  const handleAiSchedule = async () => {
    if (!aiInput.trim()) return;
    setIsAiLoading(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `당신은 학생들의 시험 일정을 정리해주는 일정 비서입니다. 사용자가 설명하는 시험 일정을 듣고, 각 과목명과 시험 일시를 추출하여 JSON 형식으로 응답해 주세요.
또한 사용자가 수면 시간(잠자는 시간)을 언급한다면, 그 시간도 함께 추출해 주세요.

오늘 날짜는 ${format(now, 'yyyy-MM-dd (eee)', { locale: ko })} 입니다. 현재 시간은 ${format(now, 'HH:mm')} 입니다.
입력된 일정 설명: "${aiInput}"

응답 형식은 다음과 같은 JSON 객체여야 합니다:
{
  "subjects": [
    { "name": "과목명", "date": "YYYY-MM-DD", "time": "HH:MM" }
  ],
  "sleep": { "start": "HH:MM", "end": "HH:MM" } // 사용자가 언급하지 않았다면 null
}
날짜는 반드시 YYYY-MM-DD 형식이어야 하며, 시간은 24시간 형식(HH:MM)이어야 합니다.`;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              subjects: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    date: { type: Type.STRING },
                    time: { type: Type.STRING },
                  },
                  required: ["name", "date", "time"]
                }
              },
              sleep: {
                type: Type.OBJECT,
                nullable: true,
                properties: {
                  start: { type: Type.STRING },
                  end: { type: Type.STRING },
                },
                required: ["start", "end"]
              }
            },
            required: ["subjects"]
          }
        }
      });

      const parsed = JSON.parse(response.text);
      if (parsed.subjects && Array.isArray(parsed.subjects)) {
        const newSubjects: Subject[] = parsed.subjects.map((item: any) => ({
          id: crypto.randomUUID(),
          name: item.name,
          examDate: `${item.date}T${item.time}:00`,
          allocatedMinutes: 30,
          tasks: []
        }));
        setSubjects([...subjects, ...newSubjects]);
        
        if (parsed.sleep) {
          setSleepRange({ start: parsed.sleep.start, end: parsed.sleep.end });
        }
        
        setIsAiAdding(false);
        setAiInput('');
      }
    } catch (error) {
      console.error("AI Schedule Parsing Error:", error);
      alert("일정을 분석하는 도중 오류가 발생했습니다. 다시 시도해 주세요.");
    } finally {
      setIsAiLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white relative font-mono text-black selection:bg-riso-yellow selection:text-black overflow-x-hidden">
      {/* Editorial Rail Right */}
      <div className="fixed right-4 top-1/2 -translate-y-1/2 hidden lg:block z-40">
         <div className="writing-vertical text-[10px] font-black uppercase tracking-[0.5em] text-gray-300">
            TIME_MANAGEMENT_STATION_v4.2 // SERIAL_PREP_0092
         </div>
      </div>

      {/* Editorial Rail Left */}
      <div className="fixed left-4 top-1/2 -translate-y-1/2 hidden lg:block z-40">
         <div className="writing-vertical-inverted text-[10px] font-black uppercase tracking-[0.5em] text-gray-300">
            NEO_BRUTALIST_EDITION // RISOGRAPH_FLOW
         </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-4 md:px-12 py-12 space-y-32 pb-32">
        
        {/* Header Section - Asymmetric & Editorial */}
        <header className="flex flex-col md:flex-row md:items-start justify-between gap-12 pt-8 relative">
          <div className="space-y-6 max-w-2xl px-1">
             <div className="inline-block bg-riso-red text-white font-black text-[10px] px-3 py-1 border-2 border-black uppercase tracking-[0.2em] shadow-brutal-sm -rotate-2">
                System Active
             </div>
             <h1 className="text-8xl md:text-[14rem] font-black tracking-tighter leading-[0.75] uppercase italic font-serif">
               D-Day
               <span className="block text-riso-blue text-2xl md:text-3xl not-italic font-sans mt-4 tracking-tight font-black">
                 EXAM_COUNTDOWN_PROTOCOL
               </span>
             </h1>
          </div>
          
          <div className="flex flex-wrap gap-4 pt-12 md:pt-24 self-start md:self-end">
             <button 
                onClick={() => setIsSettingSleep(true)}
                className="toss-button bg-riso-yellow text-black !px-10 !py-6 text-xl shadow-brutal rotate-1 hover:rotate-0 transition-transform"
              >
                수면
              </button>
              <button 
                onClick={() => setIsAiAdding(true)}
                className="toss-button bg-riso-teal text-black !px-10 !py-6 text-xl shadow-brutal -rotate-1 hover:rotate-0 transition-transform"
              >
                AI 일정
              </button>
              <button 
                id="add-subject-btn"
                onClick={() => setIsAdding(true)}
                className="toss-button bg-riso-red text-white flex items-center gap-2 !px-12 !py-8 text-2xl shadow-brutal-lg hover:translate-y-[-4px] active:translate-y-[2px]"
              >
                <Plus size={32} strokeWidth={4} />
                과목
              </button>
          </div>
        </header>

        {/* Global Countdown Section - Broken Grid & Editorial */}
        <section className="relative py-24">
           {/* Decorative Broken Grid Line */}
           <div className="absolute top-0 left-[-10vw] right-[-10vw] h-[4px] bg-black border-y border-black/10 -rotate-1 z-0" />
           
           <div className="relative z-10 space-y-16">
              <div className="overflow-hidden whitespace-nowrap border-y-2 border-black bg-white py-4 -mx-12 rotate-1 shadow-brutal-sm">
                 <div className="inline-flex animate-[marquee_25s_linear_infinite] gap-12">
                    {Array(10).fill("TICK TOCK • TIME IS RUNNING OUT • PREPARE FOR EXAM • ").map((t, i) => (
                      <span key={i} className="text-sm font-black uppercase tracking-[0.4em] text-black/20">{t}</span>
                    ))}
                 </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-12 items-start pt-12 px-2">
                <div className="md:col-span-8 space-y-8">
                  <div className="space-y-4">
                    <span className="text-[14px] font-black uppercase tracking-[0.3em] text-riso-blue border-b-4 border-riso-blue inline-block mb-4">
                       Remaining Study Capacity
                    </span>
                    <h2 className="text-9xl md:text-[20rem] font-black tracking-tighter leading-[0.7] text-black italic font-serif">
                      {soonestSubject ? formatCountdown(soonestSubject.examDate, now) : "00h 00m"}
                    </h2>
                  </div>
                </div>
                
                <div className="md:col-span-4 self-center -translate-x-12 md:translate-x-12">
                   <div className="p-10 bg-riso-blue text-white border-4 border-black shadow-brutal-lg rotate-3 hover:rotate-0 transition-transform relative z-20">
                      <div className="absolute -top-8 -left-8 bg-riso-yellow text-black border-2 border-black px-6 py-3 font-black text-xs uppercase tracking-widest shadow-brutal-sm rotate-[-15deg]">
                         CRITICAL_TARGET
                      </div>
                      <div className="flex items-center gap-4 mb-6">
                        <Clock size={32} strokeWidth={4} />
                        <span className="text-xs font-black uppercase tracking-[0.4em]">Next Deployment</span>
                      </div>
                      <p className="text-5xl font-black leading-none uppercase italic border-b-4 border-white/30 pb-6 mb-4">{soonestSubject?.name || "NONE_DETECTED"}</p>
                      <div className="flex justify-between items-center text-[11px] font-black uppercase tracking-[0.2em] opacity-60">
                         <span>STATUS: READY</span>
                         <span>LOAD_ID: 8829</span>
                      </div>
                   </div>
                   
                   {/* Background element for broken grid look */}
                   <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120%] h-[120%] border-2 border-black/5 -rotate-6 pointer-events-none hidden md:block" />
                </div>
              </div>
           </div>
        </section>

          {/* Timeline & View Mode Toggle - Asymmetric */}
          {subjects.length > 0 && (
            <div className="pt-24 space-y-16">
               <div className="flex flex-col md:flex-row items-center justify-between gap-8 px-4">
                  <div className="flex border-4 border-black bg-white p-1 shadow-brutal rotate-1">
                     <button 
                       onClick={() => setTimelineMode('today')}
                       className={cn(
                         "px-10 py-4 text-[11px] font-black tracking-widest uppercase transition-all",
                         timelineMode === 'today' ? "bg-black text-white" : "text-gray-400 hover:text-black"
                       )}
                     >
                       Today View
                     </button>
                     <button 
                       onClick={() => setTimelineMode('all')}
                       className={cn(
                         "px-10 py-4 text-[11px] font-black tracking-widest uppercase transition-all",
                         timelineMode === 'all' ? "bg-black text-white" : "text-gray-400 hover:text-black"
                       )}
                     >
                       D-Day Overview
                     </button>
                  </div>

                  <button 
                     onClick={() => setShowSleepOnTimeline(!showSleepOnTimeline)}
                     className={cn(
                       "flex items-center gap-3 px-8 py-4 border-4 border-black text-[11px] font-black uppercase tracking-widest transition-all shadow-brutal -rotate-1",
                       showSleepOnTimeline 
                        ? "bg-riso-blue text-white" 
                        : "bg-white text-gray-400 grayscale"
                     )}
                  >
                     {showSleepOnTimeline ? "Sleep Schedule ON" : "Sleep Schedule OFF"}
                  </button>
               </div>

               <div className="px-2 relative">
                 <div className="absolute -top-12 -left-4 hidden lg:block">
                    <span className="text-[10px] font-black text-riso-blue/30 uppercase writing-vertical-inverted tracking-widest">TIMELINE_VISUALIZER_REF_55</span>
                 </div>
                 {timelineMode === 'today' ? (
                     <Timeline 
                       subjects={subjects} 
                       now={now} 
                       sleepRange={sleepRange} 
                       showSleep={showSleepOnTimeline}
                       mode="today"
                     />
                 ) : (
                     <DDayOverview subjects={subjects} now={now} />
                 )}
               </div>
            </div>
          )}

        {/* Time Allocation Summary - Editorial & Asymmetric */}
        {subjects.length > 0 && (
          <section className="relative grid grid-cols-1 lg:grid-cols-12 gap-12 items-end py-24">
            <div className="lg:col-span-1 hidden lg:block">
               <div className="writing-vertical-inverted text-[10px] font-black uppercase tracking-[0.5em] text-riso-blue/40 mb-12">
                  ALLOCATION_MATRIX_V.01
               </div>
            </div>
            
            <div className="lg:col-span-7 toss-card p-12 space-y-10 relative overflow-hidden bg-white shadow-brutal-lg">
                <div className="absolute top-0 right-0 p-3 bg-black text-white text-[9px] font-black uppercase tracking-widest translate-x-1/4 -translate-y-1/4 rotate-45 px-12">
                   SYNDICATED
                </div>

                <div className="space-y-4">
                  <span className="text-[12px] font-black uppercase tracking-[0.3em] text-riso-blue italic">Load Factor Analysis</span>
                  <h3 className="text-6xl font-black uppercase tracking-tighter italic font-serif">공부 가용 시간</h3>
                </div>

                <div className="space-y-6">
                  <div className="h-10 w-full border-4 border-black bg-white flex p-1 shadow-brutal">
                    {subjects.map((s) => (
                      <motion.div 
                        key={s.id}
                        initial={{ width: 0 }}
                        animate={{ width: `${(s.allocatedMinutes / Math.max(totalAllocatedMinutes, totalAvailableMinutes)) * 100}%` }}
                        style={{ backgroundColor: getSubjectColor(s.id) }}
                        className="h-full border-r-2 border-black/20"
                      />
                    ))}
                  </div>
                  <div className="flex justify-between items-center text-[11px] font-black px-1 uppercase tracking-[0.2em]">
                    <span className={cn(allocationRatio > 100 ? "text-riso-red bg-riso-red/10 px-3 py-1 border border-riso-red" : "text-gray-400")}>
                      {allocationRatio > 100 ? "⚠️ RESOURCE_OVERLOAD" : "CAPACITY_OPTIMIZED"}
                    </span>
                    <div className="flex items-center gap-4">
                       <span className="text-riso-blue font-black">{Math.round(allocationRatio)}% RESOURCE_USE</span>
                    </div>
                  </div>
                </div>
            </div>

            <div className="lg:col-span-4 space-y-8 lg:pb-12 lg:pl-12 border-l-4 border-black border-dashed pt-12 lg:pt-0 relative">
               <div className="space-y-2">
                 <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Global Utilization Index</span>
                 <div className="flex items-baseline gap-4">
                   <span className="text-8xl font-black tracking-tighter text-black font-serif italic">
                     {formatMinutesShort(totalAllocatedMinutes)}
                   </span>
                   <span className="text-riso-blue font-black text-4xl">/</span>
                   <span className="text-gray-300 font-black text-4xl">
                     {formatMinutesShort(totalAvailableMinutes)}
                   </span>
                 </div>
               </div>
               <p className="text-sm font-bold text-gray-500 uppercase leading-snug tracking-tight max-w-[280px] italic">
                 Total study hours available across all scheduled deployments. Ensure optimal distribution to avoid burn-out.
               </p>
            </div>
          </section>
        )}

        {/* Subjects List - Editorial */}
        <div className="space-y-16">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-8 px-2 border-b-8 border-black pb-10 relative">
            <div className="space-y-4">
               <span className="text-[14px] font-black uppercase tracking-[0.4em] text-riso-red bg-riso-red/10 px-4 py-1 inline-block -rotate-1">Active Targets</span>
               <h3 className="text-8xl font-black uppercase tracking-tighter italic font-serif">목표 과목</h3>
            </div>
            
            <button 
              onClick={() => setViewMode(viewMode === 'large' ? 'compact' : 'large')}
              className="text-xs font-black px-10 py-5 border-4 border-black bg-white shadow-brutal hover:translate-y-[-2px] hover:shadow-brutal-lg active:translate-y-[2px] active:shadow-none transition-all uppercase tracking-[0.2em] relative z-10"
            >
              Mode: {viewMode === 'large' ? 'LARGE' : 'COMPACT'}
            </button>
            
            {/* Background Editorial Tag */}
            <div className="absolute right-0 top-0 hidden lg:block">
               <span className="text-[9px] font-black text-gray-200 uppercase writing-vertical translate-x-12 tracking-[0.5em]">CATALOG_v2024_Q2</span>
            </div>
          </div>
          <section className={cn("grid gap-6 pb-20", viewMode === 'large' ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2 lg:grid-cols-3")}>
            <AnimatePresence mode="popLayout">
              {sortedSubjects.length === 0 ? (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="toss-card py-24 flex flex-col items-center justify-center text-gray-700 space-y-4 col-span-full"
                >
                  <BookOpen size={48} strokeWidth={1} className="opacity-20" />
                  <p className="text-sm font-semibold">아직 추가된 시험이 없어요.</p>
                </motion.div>
              ) : (
                sortedSubjects.map((subject) => (
                  <SubjectCard 
                    key={subject.id} 
                    subject={subject} 
                    now={now}
                    viewMode={viewMode}
                    isExpanded={expandedId === subject.id}
                    onToggleExpand={() => setExpandedId(expandedId === subject.id ? null : subject.id)}
                    specificAvailable={getSpecificAvailableMinutes(subject)}
                    color={getSubjectColor(subject.id)}
                    onDelete={() => deleteSubject(subject.id)}
                    onUpdateAllocation={(m) => updateAllocation(subject.id, m)}
                    onUpdateSubject={(updates) => updateSubjectInfo(subject.id, updates)}
                    onToggleTask={(tid) => toggleTask(subject.id, tid)}
                    onAddTask={(txt) => addTask(subject.id, txt)}
                    onDeleteTask={(tid) => deleteTask(subject.id, tid)}
                  />
                ))
              )}
            </AnimatePresence>
          </section>
        </div>

      {/* Sleep Setting Modal Overlay */}
      <AnimatePresence>
        {isSettingSleep && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
            />
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-sm border-4 border-black p-10 shadow-brutal-lg space-y-10"
            >
              <div className="space-y-4">
                <div className="w-16 h-16 bg-riso-blue border-4 border-black flex items-center justify-center shadow-brutal-sm mx-auto">
                  <Timer size={32} className="text-white" />
                </div>
                <div className="text-center space-y-2">
                  <h2 className="text-3xl font-black uppercase italic tracking-tighter">Sleep Calibration</h2>
                  <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest leading-relaxed">
                    AUTOMATIC_RESOURCE_EXCLUSION_ENGAGED
                  </p>
                </div>
              </div>

              <div className="space-y-8">
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest italic ml-1">OFFLINE: START</label>
                    <input 
                      type="time" 
                      defaultValue={sleepRange?.start || "23:00"}
                      id="sleep-start"
                      className="w-full toss-input px-4 py-4 font-black text-center"
                    />
                  </div>
                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest italic ml-1">ONLINE: END</label>
                    <input 
                      type="time" 
                      defaultValue={sleepRange?.end || "07:00"}
                      id="sleep-end"
                      className="w-full toss-input px-4 py-4 font-black text-center"
                    />
                  </div>
                </div>
              </div>

              <div className="pt-4">
                <button 
                  onClick={() => {
                    const s = (document.getElementById('sleep-start') as HTMLInputElement).value;
                    const e = (document.getElementById('sleep-end') as HTMLInputElement).value;
                    setSleepRange({ start: s, end: e });
                    setIsSettingSleep(false);
                  }}
                  className="toss-button w-full px-6 py-5 !bg-riso-blue text-white text-xl"
                >
                  INITIALIZE
                </button>
              </div>
              
              <p className="text-[8px] font-black text-gray-300 text-center uppercase tracking-widest italic">Secure biological standby mode</p>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* AI Schedule Modal Overlay */}
      <AnimatePresence>
        {isAiAdding && (
          <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsAiAdding(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
            />
            <motion.div 
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 20, opacity: 0 }}
              className="relative bg-white w-full max-w-md border-4 border-black p-10 shadow-brutal-lg space-y-10"
            >
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                   <div className="w-3 h-3 bg-riso-blue" />
                </div>
                <h2 className="text-4xl font-black tracking-tighter uppercase italic leading-none flex items-center gap-3">
                  <TrendingUp size={32} strokeWidth={4} className="text-riso-blue" />
                  AI Sync
                </h2>
                <div className="h-1 w-20 bg-black" />
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest leading-relaxed italic">
                  DESCRIBE_SCHEDULE_FOR_AUTOMATED_EXTRACTION
                </p>
              </div>

              <div className="space-y-8">
                <div className="space-y-3">
                  <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest italic ml-1">Payload: DESCRIPTION</label>
                  <textarea 
                    autoFocus
                    placeholder="E.G. I HAVE MATH EXAM ON MONDAY 10AM AND ENGLISH ON WEDNESDAY 2PM..."
                    value={aiInput}
                    onChange={e => setAiInput(e.target.value)}
                    className="w-full toss-input px-6 py-5 text-sm font-black uppercase tracking-tight min-h-[140px] resize-none"
                  />
                </div>
              </div>

              <div className="flex gap-4 pt-4">
                <button 
                  onClick={() => setIsAiAdding(false)}
                  className="flex-1 px-6 py-5 border-2 border-black bg-white text-black font-black uppercase text-xs hover:bg-gray-100 transition-all cursor-pointer shadow-brutal-sm"
                >
                  ABORT
                </button>
                <button 
                  onClick={handleAiSchedule}
                  disabled={isAiLoading}
                  className="toss-button flex-[2] px-6 py-5 !bg-riso-blue text-white text-lg disabled:grayscale disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isAiLoading ? (
                    <>
                      <div className="w-5 h-5 border-4 border-white/30 border-t-white rounded-full animate-spin" />
                      PROCESS
                    </>
                  ) : "EXECUTE_SYNC"}
                </button>
              </div>
              
              <div className="pt-4 border-t border-black border-dashed opacity-30 text-center">
                 <p className="text-[8px] font-black tracking-[0.2em] uppercase italic">Quantum Scheduling Module v1.0.4</p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Add Subject Modal Overlay */}
      <AnimatePresence>
        {isAdding && (
          <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsAdding(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
            />
            <motion.div 
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 20, opacity: 0 }}
              className="relative bg-white w-full max-w-md border-4 border-black p-10 shadow-brutal-lg space-y-10"
            >
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                   <div className="w-3 h-3 bg-riso-red" />
                   <span className="text-[10px] font-black uppercase tracking-[0.4em] text-gray-500">Subject Registration</span>
                </div>
                <h2 className="text-4xl font-black tracking-tighter uppercase italic leading-none">New Entry</h2>
                <div className="h-1 w-20 bg-black" />
              </div>

              <div className="space-y-8">
                <div className="space-y-3">
                  <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest italic ml-1">Identity: SUBJECT_NAME</label>
                  <input 
                    autoFocus
                    type="text" 
                    placeholder="ENTER SUBJECT TITLE..."
                    value={newSubject.name}
                    onChange={e => setNewSubject({...newSubject, name: e.target.value})}
                    className="w-full toss-input px-6 py-5 text-lg font-black uppercase tracking-tight"
                  />
                </div>

                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest italic ml-1">Deployment: DATE</label>
                    <input 
                      type="date" 
                      value={newSubject.date}
                      onChange={e => setNewSubject({...newSubject, date: e.target.value})}
                      className="w-full toss-input px-6 py-5 font-black"
                    />
                  </div>
                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest italic ml-1">Trigger: TIME</label>
                    <input 
                      type="time" 
                      value={newSubject.time}
                      onChange={e => setNewSubject({...newSubject, time: e.target.value})}
                      className="w-full toss-input px-6 py-5 font-black"
                    />
                  </div>
                </div>
              </div>

              <div className="flex gap-4 pt-6">
                <button 
                  onClick={() => setIsAdding(false)}
                  className="flex-1 px-6 py-5 border-2 border-black bg-white text-black font-black uppercase text-xs hover:bg-gray-100 transition-all cursor-pointer shadow-brutal-sm"
                >
                  ABORT
                </button>
                <button 
                  onClick={addSubject}
                  className="toss-button flex-[2] px-6 py-5 !bg-riso-blue text-white text-lg"
                >
                  COMMIT_RECORD
                </button>
              </div>
              
              <div className="pt-4 border-t border-black border-dashed opacity-30">
                 <p className="text-[8px] font-black text-center tracking-[0.2em] uppercase">SYSTEM CONTROL: V.4.0 // RIZE_ESTATE</p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  </div>
);
}

// --- D-Day Overview Component ---

function DDayOverview({ subjects, now }: { subjects: Subject[], now: Date }) {
  const sorted = [...subjects].sort((a,b) => parseISO(a.examDate).getTime() - parseISO(b.examDate).getTime());
  
  if (sorted.length === 0) return (
    <div className="text-center py-24 border-4 border-black border-dashed bg-gray-50">
       <span className="text-xs font-black text-gray-400 uppercase tracking-widest italic">
         System: NO_ACTIVE_DEPLOYMENTS_FOUND
       </span>
    </div>
  );

  return (
    <motion.div 
       initial={{ opacity: 0, y: 10 }}
       animate={{ opacity: 1, y: 0 }}
       className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-12 pt-12"
    >
      {sorted.map(s => {
         const examTime = parseISO(s.examDate);
         const diffDays = differenceInDays(examTime, startOfDay(now));
         const color = getSubjectColor(s.id);
         const isPast = !isAfter(examTime, now);

         return (
           <div key={s.id} className={cn(
             "group flex flex-col bg-white border-4 border-black p-10 shadow-brutal-sm hover:shadow-brutal transition-all relative overflow-visible",
             isPast && "grayscale opacity-50"
           )}>
              {/* Broken Grid: Overlapping Status Label */}
              <div className="absolute -top-6 -right-4 z-20">
                 <div className="text-4xl font-black italic tracking-tighter font-serif px-4 py-2 border-4 border-black bg-white shadow-brutal-sm" style={{ color }}>
                    {diffDays === 0 ? 'D-DAY' : `D-${diffDays}`}
                 </div>
              </div>

              <div className="absolute top-0 left-0 w-12 h-12 flex items-center justify-center -translate-x-4 -translate-y-4 shadow-brutal-sm border-2 border-black rotate-[-12deg] z-10" style={{ backgroundColor: color }}>
                 <Clock size={24} className="text-white" />
              </div>

              <div className="flex-1 space-y-6">
                 <div className="space-y-2">
                    <div className="text-[10px] font-black text-riso-blue uppercase tracking-[0.4em] italic">Deployment Analysis</div>
                    <h4 className="text-4xl font-black text-black uppercase tracking-tighter truncate font-serif italic">{s.name}</h4>
                 </div>

                 <div className="flex flex-col gap-4 pt-10 border-t-4 border-black border-double h-full">
                    <div className="space-y-1">
                       <div className="text-[9px] font-black text-gray-400 uppercase tracking-widest">Time Signature</div>
                       <div className="text-xl font-bold text-black uppercase">{format(examTime, 'MMM dd / HH:mm')}</div>
                    </div>
                    <div className="mt-auto pt-4 flex justify-between items-center text-[8px] font-black uppercase text-gray-300 tracking-[0.3em]">
                       <span>REF: {s.id.slice(0,8)}</span>
                       <span>STATUS: {isPast ? 'EXPIRED' : 'ACTIVE'}</span>
                    </div>
                 </div>
              </div>
           </div>
         );
      })}
    </motion.div>
  );
}

// --- Timeline Component ---

interface TimelineProps {
  subjects: Subject[];
  now: Date;
  sleepRange: SleepRange | null;
  showSleep: boolean;
  mode: 'today' | 'all';
}

function Timeline({ subjects, now, sleepRange, showSleep, mode }: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const timelineData = useMemo(() => {
    const startTime = now.getTime();
    
    if (mode === 'today') {
      const endTime = startTime + 24 * 3600 * 1000;
      return {
        segments: [{ type: 'time', start: startTime, end: endTime, weight: 1 }],
        totalWeight: 1,
        startTime,
        endTime
      };
    }

    const sorted = [...subjects]
      .filter(s => isAfter(parseISO(s.examDate), now))
      .sort((a, b) => parseISO(a.examDate).getTime() - parseISO(b.examDate).getTime());

    // Smart Timeline Compression Logic (All Mode)
    const points = [startTime, ...sorted.map(s => parseISO(s.examDate).getTime())];
    const segments: { type: 'time' | 'gap', start: number, end: number, weight: number, days?: number }[] = [];
    
    for (let i = 0; i < points.length - 1; i++) {
        const current = points[i];
        const next = points[i+1];
        const diff = next - current;
        const limit = 24 * 3600 * 1000;

        if (diff > limit) {
           segments.push({ type: 'time', start: current, end: current + limit, weight: 2 });
           segments.push({ type: 'gap', start: current + limit, end: next, weight: 0.5, days: Math.floor(diff / limit) });
        } else {
           segments.push({ type: 'time', start: current, end: next, weight: Math.max(0.1, diff / limit) * 2 });
        }
    }

    const lastPoint = points[points.length - 1];
    segments.push({ type: 'time', start: lastPoint, end: lastPoint + 4 * 3600 * 1000, weight: 0.5 });
    const totalWeight = segments.reduce((acc, s) => acc + s.weight, 0);

    return { segments, totalWeight };
  }, [subjects, now, mode]);

  const getPositionData = (time: number) => {
    const { segments, totalWeight } = timelineData;
    let accumulatedWeight = 0;

    for (const segment of segments) {
      if (time >= segment.start && time <= segment.end) {
        const segmentProgress = (time - segment.start) / (segment.end - segment.start);
        const pos = ((accumulatedWeight + segmentProgress * segment.weight) / totalWeight) * 100;
        return { pos, inSegment: true };
      }
      accumulatedWeight += segment.weight;
      if (time < segment.start) break;
    }
    
    if (time < segments[0].start) return { pos: 0, inSegment: false };
    return { pos: 100, inSegment: false };
  };

  const sleepBlocks = useMemo(() => {
    if (!sleepRange || !showSleep) return [];
    let blocks: { start: number, end: number }[] = [];
    let temp = startOfDay(now);
    
    for (let i = 0; i < 14; i++) {
       const today = addDays(temp, i);
       const [sH, sM] = sleepRange.start.split(':').map(Number);
       const [eH, eM] = sleepRange.end.split(':').map(Number);
       
       const sDate = new Date(today); sDate.setHours(sH, sM, 0, 0);
       let eDate = new Date(today); eDate.setHours(eH, eM, 0, 0);

       if (sDate.getTime() > eDate.getTime()) {
         eDate = addDays(eDate, 1);
       }
       blocks.push({ start: sDate.getTime(), end: eDate.getTime() });
    }
    return blocks.filter(b => b.end > now.getTime());
  }, [sleepRange, now, showSleep]);

  return (
    <div className="relative w-full h-32 px-4 select-none mt-4 transition-all" ref={containerRef}>
      <div className="absolute top-1/2 left-0 w-full h-[2px] bg-black flex overflow-hidden">
         {timelineData.segments.map((seg, i) => (
            <div 
              key={i} 
              style={{ width: `${(seg.weight / timelineData.totalWeight) * 100}%` }}
              className={cn(
                "h-full transition-colors",
                seg.type === 'gap' ? "bg-[radial-gradient(circle,rgba(0,0,0,0.1)_1px,transparent_1px)] bg-[length:8px_8px]" : "bg-gray-300"
              )}
            />
         ))}
      </div>
      
      {timelineData.segments.map((seg, i) => {
         if (seg.type !== 'gap') return null;
         const { pos: left } = getPositionData(seg.start);
         const { pos: right } = getPositionData(seg.end);
         return (
           <div 
             key={i}
             className="absolute top-1/2 -translate-y-1/2 flex items-center justify-center pointer-events-none"
             style={{ left: `${left}%`, width: `${right - left}%` }}
           >
              <div className="bg-white/90 backdrop-blur-sm px-2 py-0.5 border-2 border-black">
                 <span className="text-[9px] font-black text-black whitespace-nowrap italic">
                   {seg.days}일 후
                 </span>
              </div>
           </div>
         );
      })}
      
      {sleepBlocks.map((block, idx) => {
        const { pos: left } = getPositionData(block.start);
        const { pos: right } = getPositionData(block.end);
        
        if (left >= 100 || right <= 0) return null;

        return (
          <div 
            key={idx}
            className="absolute top-0 h-full bg-blue-500/5 pointer-events-none flex flex-col justify-end"
            style={{ 
              left: `${Math.max(0, left)}%`, 
              width: `${Math.min(100, right) - Math.max(0, left)}%`,
              borderLeft: left >= 0 ? '1px solid rgba(59, 130, 246, 0.1)' : 'none',
              borderRight: right <= 100 ? '1px solid rgba(59, 130, 246, 0.1)' : 'none',
            }}
          >
            <div className="flex items-center justify-center mb-1 opacity-10">
               <span className="text-[8px] font-bold text-[#3182f6] uppercase tracking-tighter">Sleep</span>
            </div>
          </div>
        );
      })}

      {subjects.map((s) => {
        const time = parseISO(s.examDate).getTime();
        const { pos, inSegment } = getPositionData(time);
        
        if (!inSegment || pos < 0 || pos > 100) return null;
        
        const color = getSubjectColor(s.id);
        const isPast = !isAfter(parseISO(s.examDate), now);

        return (
          <div 
            key={s.id} 
            className={cn("absolute top-0 h-full flex flex-col items-center z-10 transition-all", isPast && "opacity-30")}
            style={{ left: `${pos}%` }}
          >
            <div className="absolute -top-12 flex flex-col items-center whitespace-nowrap">
               <span className="text-[10px] font-extrabold text-black mb-1">{s.name}</span>
               <div className="text-[9px] font-black text-black bg-white px-1.5 py-0.5 border border-black">
                 {format(parseISO(s.examDate), 'HH:mm')}
               </div>
            </div>
            
            <div className="h-full w-[2px] bg-black/10 relative">
              <div 
                className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-[3px] border-black shadow-brutal-sm transition-transform hover:scale-125 cursor-help"
                style={{ backgroundColor: color }}
              />
            </div>
          </div>
        );
      })}

      <div 
        className="absolute top-0 h-full flex flex-col items-center z-20 pointer-events-none transition-all duration-1000 ease-linear"
        style={{ left: `${getPositionData(now.getTime()).pos}%` }}
      >
        <div className="w-[1px] h-full bg-blue-500 shadow-[2px_0_0_rgba(59,130,246,1)] relative">
           <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-blue-500 text-white text-[9px] font-black px-1.5 py-1 shadow-brutal-sm whitespace-nowrap">
             NOW
           </div>
           <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-blue-500 rounded-full border-2 border-white" />
        </div>
      </div>
    </div>
  );
}

// --- Internal Subject Card Component ---

interface SubjectCardProps {
  key?: React.Key;
  subject: Subject;
  now: Date;
  color: string;
  viewMode: 'large' | 'compact';
  isExpanded: boolean;
  onToggleExpand: () => void;
  specificAvailable: number;
  onDelete: () => void;
  onUpdateAllocation: (mins: number) => void;
  onUpdateSubject: (updates: Partial<Pick<Subject, 'name' | 'examDate'>>) => void;
  onAddTask: (text: string) => void;
  onToggleTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
}

function SubjectCard({ 
  subject, now, color, viewMode, isExpanded, onToggleExpand, specificAvailable,
  onDelete, onUpdateAllocation, onUpdateSubject, onAddTask, onToggleTask, onDeleteTask 
}: SubjectCardProps) {
  const [taskInput, setTaskInput] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({ 
    name: subject.name, 
    date: format(parseISO(subject.examDate), 'yyyy-MM-dd'),
    time: format(parseISO(subject.examDate), 'HH:mm')
  });

  useEffect(() => {
    if (isExpanded) {
      setEditData({
        name: subject.name,
        date: format(parseISO(subject.examDate), 'yyyy-MM-dd'),
        time: format(parseISO(subject.examDate), 'HH:mm')
      });
    } else {
      setIsEditing(false);
    }
  }, [isExpanded, subject.name, subject.examDate]);

  const handleSave = () => {
    onUpdateSubject({
      name: editData.name,
      examDate: `${editData.date}T${editData.time}:00`
    });
    setIsEditing(false);
  };
  
  const completionRate = useMemo(() => {
    if (subject.tasks.length === 0) return 0;
    const completed = subject.tasks.filter(t => t.completed).length;
    return Math.round((completed / subject.tasks.length) * 100);
  }, [subject.tasks]);

  const targetDate = parseISO(subject.examDate);
  const isPast = !isAfter(targetDate, now);

  const cardTimeCountdown = () => {
    const diffSeconds = differenceInSeconds(targetDate, now);
    if (diffSeconds <= 0) return "00:00:00";
    
    const totalHours = Math.floor(diffSeconds / 3600);
    const m = Math.floor((diffSeconds % 3600) / 60);
    const s = diffSeconds % 60;
    
    return `${String(totalHours).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const getRemainingLabel = () => {
    if (isPast) return "종료됨";
    const diffSeconds = differenceInSeconds(targetDate, now);
    const totalHours = Math.floor(diffSeconds / 3600);
    return `${totalHours}시간 남음`;
  };

  if (viewMode === 'compact') {
    return (
      <motion.div 
        layout
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        onClick={onToggleExpand}
        className={cn(
          "toss-card flex flex-col p-8 space-y-6 cursor-pointer relative overflow-visible",
          isExpanded ? "z-20 bg-white" : "aspect-square"
        )}
      >
        <div className="absolute top-0 right-0 p-3 opacity-20 rotate-12">
           <Trash2 size={24} strokeWidth={3} className="text-gray-300" />
        </div>

        {/* Broken Grid Element for Compact */}
        <div className="absolute -top-4 -left-4 z-20">
           <div className="bg-black text-white px-3 py-1 font-black text-[9px] uppercase tracking-widest shadow-brutal-sm -rotate-6">
              SEQ_{subject.id.slice(0,4)}
           </div>
        </div>

        <div className="flex justify-between items-start relative z-10">
          <div className="flex-1 space-y-3">
            <h3 className="text-3xl font-black uppercase tracking-tighter truncate font-serif italic">
              {subject.name}
            </h3>
            <div className="text-[10px] font-black uppercase tracking-widest px-3 py-1 border-2 border-black inline-block shadow-brutal-sm" style={{ backgroundColor: color, color: '#fff' }}>
              {getRemainingLabel()}
            </div>
          </div>
          <button 
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="w-10 h-10 flex items-center justify-center border-4 border-black bg-white hover:bg-riso-red hover:text-white transition-all cursor-pointer shadow-brutal-sm"
          >
            <Trash2 size={18} strokeWidth={4} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-3 min-h-0 py-1 scrollbar-hide border-y-2 border-black border-dashed my-2">
          {subject.tasks.map(task => (
            <div key={task.id} className="flex items-center gap-2">
              <div 
                className="w-4 h-4 border-2 border-black shrink-0 flex items-center justify-center bg-white"
                onClick={(e) => { e.stopPropagation(); onToggleTask(task.id); }}
                style={{ backgroundColor: task.completed ? color : 'white' }}
              >
                {task.completed && <CheckCircle2 size={10} strokeWidth={4} className="text-white" />}
              </div>
              <span className={cn(
                "text-[10px] font-bold uppercase truncate",
                task.completed ? "text-gray-400 line-through" : "text-black"
              )}>
                {task.text}
              </span>
            </div>
          ))}
          {subject.tasks.length === 0 && <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest italic leading-relaxed">System: EMPTY_TASK_SLOT</p>}
        </div>

        {isExpanded && (
          <motion.div 
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="bg-riso-teal/10 p-4 border-2 border-black space-y-4"
            onClick={e => e.stopPropagation()}
          >
            {isEditing ? (
              <div className="space-y-3">
                <input 
                  type="text"
                  value={editData.name}
                  onChange={e => setEditData({ ...editData, name: e.target.value })}
                  className="toss-input w-full p-2 text-xs"
                  placeholder="과목 이름"
                />
                <div className="flex gap-2">
                  <input 
                    type="date"
                    value={editData.date}
                    onChange={e => setEditData({ ...editData, date: e.target.value })}
                    className="toss-input flex-1 p-2 text-[10px]"
                  />
                  <input 
                    type="time"
                    value={editData.time}
                    onChange={e => setEditData({ ...editData, time: e.target.value })}
                    className="toss-input flex-1 p-2 text-[10px]"
                  />
                </div>
                <div className="flex gap-2">
                  <button onClick={handleSave} className="toss-button flex-1 bg-riso-blue text-[10px] py-2">SAVE</button>
                  <button onClick={() => setIsEditing(false)} className="toss-button flex-1 bg-white !text-black text-[10px] py-2">CANCEL</button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex justify-between items-center border-b border-black pb-1">
                   <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest italic">Entry Details</span>
                   <button 
                     onClick={() => setIsEditing(true)}
                     className="text-[9px] font-black text-riso-blue hover:underline uppercase tracking-widest"
                   >
                     EDIT_ENTRY
                   </button>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-black text-black uppercase">{subject.name}</p>
                  <p className="text-[10px] text-gray-500 font-bold uppercase">{format(targetDate, 'MMMM do, HH:mm')}</p>
                </div>
              </div>
            )}
          </motion.div>
        )}

        <div className="pt-3 space-y-3">
          <div className="flex items-center justify-between border-2 border-black p-1 bg-gray-50">
            <button 
              onClick={(e) => { e.stopPropagation(); onUpdateAllocation(Math.max(0, subject.allocatedMinutes - 30)); }}
              className="w-8 h-8 border-2 border-black bg-white flex items-center justify-center hover:bg-riso-red hover:text-white transition-all cursor-pointer shadow-brutal-sm active:shadow-none translate-x-0"
            >
              <Minus size={14} strokeWidth={4} />
            </button>
            <div className="text-xs font-black text-black text-center uppercase tracking-tighter">
              {Math.floor(subject.allocatedMinutes / 60)}H {subject.allocatedMinutes % 60}M
            </div>
            <button 
              onClick={(e) => { e.stopPropagation(); onUpdateAllocation(Math.min(specificAvailable, subject.allocatedMinutes + 30)); }}
              className="w-8 h-8 border-2 border-black bg-white flex items-center justify-center hover:bg-riso-blue hover:text-white transition-all cursor-pointer shadow-brutal-sm active:shadow-none translate-x-0"
            >
              <Plus size={14} strokeWidth={4} />
            </button>
          </div>
          <div className="h-4 w-full border-2 border-black bg-white p-0.5 shadow-brutal-sm">
             <div 
               className="h-full transition-all border-r-2 border-black/20" 
               style={{ width: `${Math.min(100, (subject.allocatedMinutes / Math.max(1, specificAvailable)) * 100)}%`, backgroundColor: color }}
             />
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div 
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      onClick={onToggleExpand}
      className={cn(
        "toss-card relative group cursor-pointer bg-white overflow-visible",
        isExpanded && "shadow-brutal-lg translate-x-[-2px] translate-y-[-2px]"
      )}
    >
      {/* Broken Grid: Overlapping Date Label */}
      <div className="absolute -top-6 -right-6 z-30">
         <div 
           className="px-6 py-3 border-4 border-black font-black text-white text-xs uppercase tracking-[0.2em] shadow-brutal-sm rotate-3"
           style={{ backgroundColor: color }}
         >
            {format(targetDate, 'MM/dd')}
         </div>
      </div>

      <div className="p-10 space-y-12 relative z-10">
        {/* Card Header - Editorial Style */}
        <div className="flex flex-col md:flex-row justify-between items-start gap-8 border-b-4 border-black border-dashed pb-10">
          <div className="space-y-6 flex-1">
            <div className="flex items-center gap-6">
               <div className="w-16 h-16 border-4 border-black bg-white flex items-center justify-center shadow-brutal flex-shrink-0" style={{ transform: 'rotate(-3deg)' }}>
                  <TrendingUp size={32} strokeWidth={4} style={{ color }} />
               </div>
               <h3 className="text-5xl md:text-7xl font-black tracking-tighter uppercase leading-none font-serif italic">
                {subject.name}
              </h3>
            </div>
            
            <div className="flex flex-wrap items-center gap-6 text-sm font-black uppercase tracking-[0.2em]">
              <span className="px-6 py-2 border-4 border-black bg-riso-yellow text-black shadow-brutal-sm">{getRemainingLabel()}</span>
              <span className="text-black/30 text-2xl font-serif">/</span>
              <span className="text-gray-400 border-b-2 border-black/10">{format(targetDate, 'HH:mm')} LOCAL_TIME</span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-4 min-w-[200px]">
             <div className="text-7xl font-black text-black tracking-tighter italic font-mono" style={{ color }}>
               {cardTimeCountdown()}
             </div>
             <button 
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="text-[10px] font-black px-6 py-2 border-2 border-black bg-white hover:bg-riso-red hover:text-white transition-all uppercase tracking-widest shadow-brutal-sm"
              >
                DELETE_RECORD
              </button>
          </div>
        </div>

        {isExpanded && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-riso-blue/5 border-4 border-black p-8 space-y-8 shadow-brutal"
            onClick={e => e.stopPropagation()}
          >
            {isEditing ? (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-gray-500 uppercase px-1 tracking-widest italic">Entry Subject Name</label>
                    <input 
                      type="text"
                      value={editData.name}
                      onChange={e => setEditData({ ...editData, name: e.target.value })}
                      className="toss-input w-full p-4 text-lg font-black uppercase"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-gray-500 uppercase px-1 tracking-widest italic">Timestamp Configuration</label>
                    <div className="flex gap-4">
                       <input 
                        type="date"
                        value={editData.date}
                        onChange={e => setEditData({ ...editData, date: e.target.value })}
                        className="toss-input flex-1 p-4"
                      />
                      <input 
                        type="time"
                        value={editData.time}
                        onChange={e => setEditData({ ...editData, time: e.target.value })}
                        className="toss-input flex-[0.6] p-4"
                      />
                    </div>
                  </div>
                </div>
                <div className="flex gap-4 pt-4">
                  <button onClick={handleSave} className="toss-button flex-1 bg-riso-blue py-5 text-lg">SAVE_CHANGES</button>
                  <button onClick={() => setIsEditing(false)} className="toss-button flex-1 bg-white !text-black py-5 text-lg">DISCARD</button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col md:flex-row items-center justify-between gap-8">
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-riso-red animate-pulse" />
                      <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Active Schedule Log</p>
                  </div>
                  <h4 className="text-4xl font-black text-black uppercase leading-tight italic">{subject.name}</h4>
                  <p className="text-sm text-gray-600 font-bold uppercase leading-relaxed max-w-lg">
                    시험 예정 일시: {format(targetDate, 'yyyy MM dd - HH:mm')} 기점으로 타임라인이 동기화됩니다.
                  </p>
                </div>
                <button 
                  onClick={() => setIsEditing(true)}
                  className="toss-button bg-riso-blue text-white px-8 py-5 text-sm"
                >
                  CONFIGURE_SCHEDULE
                </button>
              </div>
            )}
          </motion.div>
        )}

        {/* Tasks Section */}
        <div className="space-y-8" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-3">
               <span className="text-[12px] font-black text-black uppercase tracking-[0.3em] underline decoration-4 decoration-riso-blue">Study Protocol</span>
               <div className="text-[9px] font-bold bg-black text-white px-2 py-0.5 uppercase tracking-widest">{subject.tasks.length} ENTRIES</div>
            </div>
            <div className="flex items-center gap-3">
               <span className="text-[10px] font-black uppercase text-gray-400">Completion Path</span>
               <span className="text-2xl font-black italic tracking-tighter" style={{ color }}>
                  {completionRate}%
               </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {subject.tasks.map(task => (
              <div key={task.id} className="group/item flex items-center gap-4 bg-white p-4 border-2 border-black hover:shadow-brutal-sm transition-all" onClick={e => e.stopPropagation()}>
                <div 
                  onClick={(e) => { e.stopPropagation(); onToggleTask(task.id); }}
                  className={cn(
                    "w-6 h-6 border-2 border-black shrink-0 transition-all flex items-center justify-center cursor-pointer",
                    task.completed ? "bg-black" : "bg-white hover:bg-gray-100"
                  )}
                  style={{ backgroundColor: task.completed ? color : undefined }}
                >
                  {task.completed && <CheckCircle2 size={16} strokeWidth={4} className="text-white" />}
                </div>
                <span className={cn(
                  "text-xs font-black uppercase tracking-tight flex-1 truncate",
                  task.completed ? "text-gray-300 line-through" : "text-black"
                )}>
                  {task.text}
                </span>
                <button 
                  onClick={(e) => { e.stopPropagation(); onDeleteTask(task.id); }}
                  className="opacity-0 group-hover/item:opacity-100 text-black hover:text-riso-red transition-all p-1 cursor-pointer"
                >
                  <Trash2 size={16} strokeWidth={3} />
                </button>
              </div>
            ))}
            
            <div className="flex gap-4 col-span-full mt-4">
              <input 
                type="text" 
                placeholder="ADD STUDY MISSION..."
                value={taskInput}
                onChange={e => setTaskInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && taskInput.trim()) {
                    onAddTask(taskInput.trim());
                    setTaskInput('');
                  }
                }}
                className="toss-input flex-1 px-6 py-4 text-sm font-black uppercase tracking-widest !bg-riso-teal/5"
              />
              <button 
                onClick={() => {
                  if (taskInput.trim()) {
                    onAddTask(taskInput.trim());
                    setTaskInput('');
                  }
                }}
                className="toss-button px-8 !bg-black text-white"
              >
                INFUSE
              </button>
            </div>
          </div>
        </div>

        <div className="pt-8 border-t-2 border-black border-dashed flex flex-col md:flex-row items-center gap-8">
           <div className="flex-1 w-full space-y-4">
              <div className="flex justify-between items-end px-1">
                 <span className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">Resource Allocation</span>
                 <div className="text-2xl font-black tracking-tighter">
                    {Math.floor(subject.allocatedMinutes / 60)}H {subject.allocatedMinutes % 60}M
                 </div>
              </div>
              <div className="h-6 w-full border-2 border-black bg-white p-1 shadow-brutal-sm">
                 <div 
                   className="h-full border-r-2 border-black/20" 
                   style={{ width: `${Math.min(100, (subject.allocatedMinutes / Math.max(1, specificAvailable)) * 100)}%`, backgroundColor: color }}
                 />
              </div>
           </div>

           <div className="flex gap-2 shrink-0">
              <button 
                onClick={(e) => { e.stopPropagation(); onUpdateAllocation(Math.max(0, subject.allocatedMinutes - 30)); }}
                className="w-14 h-14 border-2 border-black bg-white flex items-center justify-center hover:bg-riso-red hover:text-white transition-all shadow-brutal-sm active:shadow-none translate-x-0"
              >
                <Minus size={24} strokeWidth={4} />
              </button>
              <button 
                onClick={(e) => { e.stopPropagation(); onUpdateAllocation(Math.min(specificAvailable, subject.allocatedMinutes + 30)); }}
                className="w-14 h-14 border-2 border-black bg-riso-blue text-white flex items-center justify-center hover:shadow-brutal hover:translate-y-[-2px] transition-all shadow-brutal-sm active:shadow-none translate-x-0"
              >
                <Plus size={24} strokeWidth={4} />
              </button>
           </div>
        </div>
      </div>
    </motion.div>
  );
}
