import { Schema, model } from 'mongoose';

export interface IPeriod {
  number: number;
  start: string; // HH:MM
  end: string; // HH:MM
}

export interface ISchoolSettings {
  workingDays: number[]; // 1 = Monday ... 7 = Sunday
  periods: IPeriod[];
  attendanceMode: 'daily';
  attendanceEditWindowHours: number;
  leaveTypes: string[];
  allowInstallments: boolean;
  academicYear: string; // e.g. 2026-27
}

export interface IHoliday {
  date: string; // YYYY-MM-DD
  name: string;
}

export interface ISchool {
  name: string;
  address?: string;
  phone?: string;
  code: string;
  plan: string;
  settings: ISchoolSettings;
  holidays: IHoliday[];
  timetable: {
    publishedVersion: number;
    publishedAt?: Date;
    draftUpdatedAt?: Date;
  };
}

const periodSchema = new Schema<IPeriod>(
  { number: { type: Number, required: true }, start: String, end: String },
  { _id: false },
);

const schoolSchema = new Schema<ISchool>(
  {
    name: { type: String, required: true, trim: true },
    address: String,
    phone: String,
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    plan: { type: String, default: 'pilot' },
    settings: {
      workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
      periods: { type: [periodSchema], default: [] },
      attendanceMode: { type: String, enum: ['daily'], default: 'daily' },
      attendanceEditWindowHours: { type: Number, default: 24 },
      leaveTypes: { type: [String], default: ['Casual', 'Sick', 'Earned'] },
      allowInstallments: { type: Boolean, default: true },
      academicYear: { type: String, default: '2026-27' },
    },
    holidays: {
      type: [new Schema<IHoliday>({ date: String, name: String }, { _id: false })],
      default: [],
    },
    timetable: {
      publishedVersion: { type: Number, default: 0 },
      publishedAt: Date,
      draftUpdatedAt: Date,
    },
  },
  { timestamps: true },
);

export const School = model<ISchool>('School', schoolSchema);
