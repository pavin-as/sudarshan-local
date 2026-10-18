/**
 * Core Medical Scheduling System Functions
 * Handles data loading, patient processing, and time block management
 */

// Configuration
const CONFIG = {
  SLOT_LENGTH: 10, // Base slot size in minutes
  BLOCK_GAP_THRESHOLD: 5, // Minutes gap to split blocks
  MINIMUM_SLOT_SIZE: 3, // Smallest schedulable segment
  CHECKIN_BUFFER: 0, // Minutes before appointment for check-in
  DEFAULT_CONSULT_TIME: 10, // Default consultation time
  FIXED_SLOT_WINDOW: 60, // Plus/minus minutes allowed for fixed slots
  CLINIC_START_TIME: "09:00", // Global clinic start time
  EXTENDED_SLOT_PERCENTAGE: 0.2, // Example value, adjust as needed
};

// Add family group configuration
const FAMILY_CONFIG = {
  GROUP_INDICATOR_COL: "J", // Column containing family group indicators (F1, F2, etc.)
  GROUP_PREFIX: "F", // Prefix used for family group indicators
};

// Heap implementation for priority queues
class Heap {
  constructor(comparator) {
    this.heap = [];
    this.comparator = comparator;
  }

  size() {
    return this.heap.length;
  }

  isEmpty() {
    return this.size() === 0;
  }

  peek() {
    return this.heap[0];
  }

  insert(value) {
    this.heap.push(value);
    this.bubbleUp(this.size() - 1);
  }

  extract() {
    if (this.isEmpty()) return null;

    const root = this.heap[0];
    const last = this.heap.pop();

    if (!this.isEmpty()) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }

    return root;
  }

  bubbleUp(index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.comparator(this.heap[index], this.heap[parentIndex]) >= 0) break;

      [this.heap[index], this.heap[parentIndex]] = [
        this.heap[parentIndex],
        this.heap[index],
      ];
      index = parentIndex;
    }
  }

  bubbleDown(index) {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (
        leftChild < this.size() &&
        this.comparator(this.heap[leftChild], this.heap[smallest]) < 0
      ) {
        smallest = leftChild;
      }

      if (
        rightChild < this.size() &&
        this.comparator(this.heap[rightChild], this.heap[smallest]) < 0
      ) {
        smallest = rightChild;
      }

      if (smallest === index) break;

      [this.heap[index], this.heap[smallest]] = [
        this.heap[smallest],
        this.heap[index],
      ];
      index = smallest;
    }
  }
}

class MaxHeap extends Heap {
  constructor(comparator) {
    super((a, b) => -comparator(a, b));
  }
}

class MinHeap extends Heap {
  constructor(comparator) {
    super(comparator);
  }
}

// Main driver function
function loadAndProcessAppointments() {
  try {
    // 1. Load Data
    const appointments = loadAppointmentData();
    const patients = appointments.map((row) => buildPatientObject(row));
    const byDate = groupPatientsByDate(patients);

    return {
      success: true,
      patients: patients,
      byDate: byDate,
    };
  } catch (e) {
    Logger.log("Error: %s\nStack: %s", e.message, e.stack);
    return { success: false, message: e.message };
  }
}

// Loads patient and procedure data from Google Sheets
function loadAppointmentData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("slotOptimization");
  const planOfActionSheet = ss.getSheetByName("PlanOfActionMaster");

  // Validate sheets exist
  if (!sheet || !planOfActionSheet) {
    throw new Error("Required sheets not found");
  }

  Logger.log("\n=== Loading Appointment Data ===");
  Logger.log("Checking for fixed appointments in spreadsheet...");

  // Load PlanOfActionMaster data and create procedure map
  const planData = planOfActionSheet.getDataRange().getDisplayValues();
  const planHeaders = planData[0];
  const procedureData = new Map();

  // Create procedure data map
  const procCol = planHeaders.indexOf("Plan of action");
  const prepCol = planHeaders.indexOf("PrepMin");
  const consultCol = planHeaders.indexOf("ConsultMin");
  const priorityCol = planHeaders.indexOf("Priority");

  for (let i = 1; i < planData.length; i++) {
    const row = planData[i];
    const procedure = row[procCol];
    if (!procedure) continue;
    procedureData.set(procedure, {
      prep: parseInt(row[prepCol], 10) || 0,
      duration: parseInt(row[consultCol], 10) || CONFIG.DEFAULT_CONSULT_TIME,
      priority: parseInt(row[priorityCol], 10) || 999,
    });
  }

  // Get appointment data
  const data = sheet.getDataRange().getDisplayValues();
  const headers = data[0];

  // Create column index map
  const colIndex = {
    date: headers.indexOf("Date"),
    timeSlot: headers.indexOf("TimeSlot"),
    mrd: headers.indexOf("MRD No"),
    name: headers.indexOf("Patient Name"),
    age: headers.indexOf("Age"),
    gender: headers.indexOf("Gender"),
    mobile: headers.indexOf("Mobile"),
    procedures: headers.indexOf("Procedures"),
    fixed: 8, // Column I (0-based index)
    familyGroup: 9, // Column J
  };

  Logger.log(`\nColumn indices found:`);
  Logger.log(`- Fixed column index: ${colIndex.fixed}`);
  Logger.log(`- TimeSlot column index: ${colIndex.timeSlot}`);

  // Process each row
  return data
    .slice(1)
    .map((row, i) => {
      const rowNum = i + 2;
      const mrd = row[colIndex.mrd];
      if (!mrd || mrd.trim() === "") return null;

      // Get family group information
      const familyGroup = row[colIndex.familyGroup] || "";
      const isPartOfFamily =
        familyGroup &&
        familyGroup.toString().trim().startsWith(FAMILY_CONFIG.GROUP_PREFIX);

      // Process TimeSlot
      let timeSlot = row[colIndex.timeSlot] || "";
      if (timeSlot instanceof Date) {
        timeSlot = Utilities.formatDate(
          timeSlot,
          Session.getScriptTimeZone(),
          "HH:mm",
        );
      }
      timeSlot = timeSlot.trim();

      // Process Fixed Slot status with detailed logging
      const fixedValue = (row[colIndex.fixed] || "").toString().toLowerCase();
      const isFixed = fixedValue === "fixed";

      if (isFixed) {
        Logger.log(`\nFound Fixed Appointment - Row ${rowNum}:`);
        Logger.log(`- MRD: ${mrd}`);
        Logger.log(`- Name: ${row[colIndex.name]}`);
        Logger.log(`- Fixed Value: "${fixedValue}"`);
        Logger.log(`- Time Slot: ${timeSlot}`);
      }

      // Process Procedures
      let procedures = [];
      const procString = row[colIndex.procedures] || "";
      try {
        procedures = procString.startsWith("[")
          ? JSON.parse(procString.replace(/""/g, '"'))
          : procString
              .split(",")
              .map((p) => p.trim())
              .filter((p) => p);
      } catch (e) {
        Logger.log(`Error parsing procedures for MRD ${mrd}: ${e.message}`);
      }

      return {
        Date: row[colIndex.date],
        TimeSlot: timeSlot,
        "MRD No": mrd,
        "Patient Name": row[colIndex.name],
        Age: row[colIndex.age],
        Gender: row[colIndex.gender],
        Mobile: row[colIndex.mobile],
        Procedures: procedures,
        ProcedureData: procedureData,
        isFixed: isFixed,
        familyGroup: familyGroup,
        isPartOfFamily: isPartOfFamily,
        fixedSlotTime: timeSlot,
      };
    })
    .filter((row) => row !== null);
}

// Cleans up procedure names
function cleanProcedureName(procedure) {
  return procedure.replace(/\s*\([^)]*\)\s*/, "").trim();
}

// Converts a raw row into a patient object
function buildPatientObject(row) {
  const procedures = row.Procedures || [];
  let consultTime = 0;
  let priority = 999;
  let totalPrepTime = 0;

  procedures.forEach((proc) => {
    const cleanProc = cleanProcedureName(proc);
    const procData = row.ProcedureData.get(cleanProc) || {
      duration: CONFIG.DEFAULT_CONSULT_TIME,
      priority: 999,
      prep: 0,
    };

    consultTime = Math.max(consultTime, procData.duration);
    priority = Math.min(priority, procData.priority);
    totalPrepTime += procData.prep || 0;
  });

  const patient = {
    date: row.Date,
    timeSlot: row.TimeSlot,
    mrd: row["MRD No"],
    name: row["Patient Name"],
    age: row.Age,
    gender: row.Gender,
    mobile: row.Mobile,
    procedures: procedures,
    consultTime: consultTime,
    priority: priority,
    prepTime: totalPrepTime,
    isScheduled: false,
    familyGroup: row.familyGroup,
    isPartOfFamily: row.isPartOfFamily,
    isFixed: row.isFixed || false,
    fixedSlotTime: row.fixedSlotTime || row.requestedTime,
  };

  Logger.log("\n=== Patient Object Created ===");
  Logger.log(`MRD: ${patient.mrd}`);
  Logger.log(`Name: ${patient.name}`);
  Logger.log(`Time Slot: ${patient.timeSlot}`);
  Logger.log(`Fixed Slot: ${patient.isFixed ? "Yes" : "No"}`);
  Logger.log(`Family Group: ${patient.familyGroup || "None"}`);
  Logger.log(`Consult Time: ${consultTime} mins`);
  Logger.log(`Priority: ${priority}`);
  Logger.log(`Prep Time: ${totalPrepTime} mins`);
  Logger.log(`Procedures: ${procedures.join(", ")}`);

  return patient;
}

// Organizes patients by date
function groupPatientsByDate(patients) {
  Logger.log("\n=== Grouping Patients by Date ===");
  Logger.log(`Total patients to group: ${patients.length}`);

  const groups = patients.reduce((groups, patient) => {
    if (!patient.date) return groups;

    let dateKey;
    try {
      const dateObj = new Date(patient.date);
      dateKey = Utilities.formatDate(
        dateObj,
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      );
    } catch (e) {
      Logger.log(
        "❌ Invalid date format for patient %s: %s",
        patient.mrd,
        patient.date,
      );
      return groups;
    }

    (groups[dateKey] = groups[dateKey] || []).push(patient);
    return groups;
  }, {});

  // Log grouping results
  Object.entries(groups).forEach(([date, patients]) => {
    Logger.log(`\nDate: ${date}`);
    Logger.log(`Total patients: ${patients.length}`);

    // Count fixed and family patients
    const fixedPatients = patients.filter((p) => p.isFixed);
    const familyPatients = patients.filter((p) => p.isPartOfFamily);

    Logger.log(`Fixed patients: ${fixedPatients.length}`);
    Logger.log(`Family patients: ${familyPatients.length}`);

    // Log family groups
    const familyGroups = new Set(familyPatients.map((p) => p.familyGroup));
    familyGroups.forEach((group) => {
      const members = familyPatients.filter((p) => p.familyGroup === group);
      Logger.log(`\nFamily Group ${group}:`);
      members.forEach((m) => Logger.log(`- ${m.name} (MRD: ${m.mrd})`));
    });
  });

  return groups;
}

// Builds availability blocks
function createAvailabilityBlocks(patients) {
  Logger.log("=== Creating Availability Blocks ===");
  Logger.log(`Total patients to process: ${patients.length}`);

  /*// Remove preallocated fixed blocks
    const fixedAppointments = patients.filter(p => p.isFixed);
    const remainingPatients = patients.filter(p => !p.isFixed);

    Logger.log(`Fixed appointments: ${fixedAppointments.length}`);
    Logger.log(`Remaining patients: ${remainingPatients.length}`);*/

  const slotSet = new Set();
  const clinicStartMins = timeStringToMinutes(CONFIG.CLINIC_START_TIME);
  patients.forEach((p) => {
    const time = p.isFixed ? p.fixedSlotTime : p.timeSlot;
    if (time) {
      const mins = timeStringToMinutes(time);
      if (!isNaN(mins) && mins >= clinicStartMins) {
        slotSet.add(mins);
      }
    }
  });

  Logger.log(`Found ${slotSet.size} unique time slots`);
  const sortedSlots = Array.from(slotSet).sort((a, b) => a - b);
  if (sortedSlots.length === 0) {
    Logger.log("No valid time slots found");
    return [];
  }

  // Create time blocks
  const blocks = [];
  let currentBlock = {
    start: sortedSlots[0],
    end: sortedSlots[0] + CONFIG.SLOT_LENGTH,
    available: [
      { start: sortedSlots[0], end: sortedSlots[0] + CONFIG.SLOT_LENGTH },
    ],
  };
  for (let i = 1; i < sortedSlots.length; i++) {
    const slotStart = sortedSlots[i];
    const gap = slotStart - currentBlock.end;
    if (gap <= CONFIG.BLOCK_GAP_THRESHOLD) {
      currentBlock.end = slotStart + CONFIG.SLOT_LENGTH;
      currentBlock.available[0].end = currentBlock.end;
    } else {
      blocks.push(currentBlock);
      currentBlock = {
        start: slotStart,
        end: slotStart + CONFIG.SLOT_LENGTH,
        available: [{ start: slotStart, end: slotStart + CONFIG.SLOT_LENGTH }],
      };
    }
  }
  blocks.push(currentBlock);

  /*// Add extended block at the end
    if (blocks.length > 0) {
        const clinicStartMins = timeStringToMinutes(CONFIG.CLINIC_START_TIME);
        const lastBlock = blocks[blocks.length - 1];
        const totalBlockDuration = lastBlock.end - clinicStartMins;
        const extendedDuration = Math.floor(totalBlockDuration * CONFIG.EXTENDED_SLOT_PERCENTAGE);
        if (extendedDuration >= CONFIG.MINIMUM_SLOT_SIZE) {
            const extendedStart = lastBlock.end;
            const extendedEnd = extendedStart + extendedDuration;

            // Create extended block with slots
            const extendedBlock = {
                start: extendedStart,
                end: extendedEnd,
                available: [],
                isExtendedBlock: true
            };

            let current = extendedStart;
            while (current < extendedEnd) {
                const slotEnd = current + CONFIG.SLOT_LENGTH;
                extendedBlock.available.push({ start: current, end: slotEnd });
                current = slotEnd;
            }

            blocks.push(extendedBlock);
        }
    }
    */

  // Add formatted blocks
  const formattedBlocks = blocks.map((b) => ({
    ...b,
    startTime: minutesToTimeString(b.start),
    endTime: minutesToTimeString(b.end),
    originalSlots: Array.from(
      { length: (b.end - b.start) / CONFIG.SLOT_LENGTH },
      (_, i) => b.start + i * CONFIG.SLOT_LENGTH,
    ).map((m) => minutesToTimeString(m)),
    isFixedBlock: false, // All blocks are non-fixed now
  }));

  return formattedBlocks;
}

// Utility functions for time conversion
function timeStringToMinutes(timeStr) {
  if (!timeStr) return NaN;
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + (minutes || 0);
}

function minutesToTimeString(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const mins = Math.floor(totalMinutes % 60);
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
}

/**
 * Main driver function for generating optimized schedules
 * @returns {Object} Object containing success status and optimized schedules
 */
function generateOptimizedSchedules() {
  try {
    Logger.log("=== Starting Schedule Optimization ===");
    // 1. Load and process appointment data
    const { success, patients, byDate } = loadAndProcessAppointments();
    if (!success) {
      throw new Error("Failed to load appointment data");
    }
    Logger.log(`
Successfully loaded ${patients.length} total patients`);
    // 2. Process each date separately
    const optimizedSchedules = {};
    for (const [date, datePatients] of Object.entries(byDate)) {
      Logger.log(`
Processing date: ${date}`);
      Logger.log(`Total patients for this date: ${datePatients.length}`);
      // 3. Create availability blocks for this date
      const availabilityBlocks = createAvailabilityBlocks(datePatients);
      // 4. Schedule patients into blocks
      const { scheduled, rescheduleList, blocks, remainingSlots } =
        schedulePatients(datePatients, availabilityBlocks);
      // 5. Store the optimized schedule for this date
      optimizedSchedules[date] = {
        patients: datePatients,
        blocks: blocks,
        scheduled: scheduled,
        rescheduleList: rescheduleList,
        totalPatients: datePatients.length,
        fixedAppointments: datePatients.filter((p) => p.isFixed).length,
        familyGroups: new Set(
          datePatients
            .filter((p) => p.isPartOfFamily)
            .map((p) => p.familyGroup),
        ).size,
        remainingSlots: remainingSlots, // Store remainingSlots
      };
      Logger.log(
        `Created ${availabilityBlocks.length} availability blocks for ${date}`,
      );
      Logger.log(`Successfully scheduled ${scheduled.length} patients`);
      if (rescheduleList.length > 0) {
        Logger.log(`Failed to schedule ${rescheduleList.length} patients`);
      }
    }
    // After building 'optimizedSchedules', collect data for outputResults:
    const allRescheduleList = [];
    const allRemainingSlots = [];
    const results = optimizedSchedules;
    // Collect reschedule lists and remaining slots
    for (const [date, data] of Object.entries(optimizedSchedules)) {
      allRescheduleList.push(...data.rescheduleList);
      // Collect remaining slots from each block's available slots
      data.blocks.forEach((block) => {
        block.available.forEach((slot) => {
          allRemainingSlots.push({
            date: date,
            start: block.start,
            end: block.end,
            startTime: block.startTime,
            endTime: block.endTime,
            slotStart: slot.start,
            slotEnd: slot.end,
          });
        });
      });
      // Add remaining slots from the extended block
      allRemainingSlots.push(
        ...data.remainingSlots.map((rs) => ({
          date: date,
          start: rs.start,
          end: rs.end,
          startTime: rs.startTime,
          endTime: rs.endTime,
          slotStart: rs.start,
          slotEnd: rs.end,
        })),
      );
    }
    // Add detailed logging of final schedules
    Logger.log("=== FINAL SCHEDULE ALLOCATIONS ===");
    for (const [date, schedule] of Object.entries(optimizedSchedules)) {
      Logger.log(`📅 Date: ${date}`);
      Logger.log(`Total Patients: ${schedule.totalPatients}`);
      Logger.log(`Fixed Appointments: ${schedule.fixedAppointments}`);
      Logger.log(`Family Groups: ${schedule.familyGroups}`);
      Logger.log(`Successfully Scheduled: ${schedule.scheduled.length}`);
      Logger.log(`Failed to Schedule: ${schedule.rescheduleList.length}`);
      Logger.log("📋 Detailed Schedule:");
      schedule.blocks.forEach((block, index) => {
        const blockType = block.isExtendedBlock ? "EXTENDED" : "Regular";
        Logger.log(`
              Block ${index + 1} (${blockType}):`);
        Logger.log(`Block ${index + 1}:`);
        Logger.log(`Time Range: ${block.startTime} - ${block.endTime}`);
        const blockScheduled = schedule.scheduled.filter(
          (p) =>
            p.consultStart === block.startTime ||
            (timeStringToMinutes(p.consultStart) >=
              timeStringToMinutes(block.startTime) &&
              timeStringToMinutes(p.consultEnd) <=
                timeStringToMinutes(block.endTime)),
        );
        if (blockScheduled.length > 0) {
          Logger.log("Scheduled Patients:");
          blockScheduled.forEach((patient) => {
            Logger.log(`  👤 ${patient.name} (MRD: ${patient.mrd})`);
            Logger.log(`    - Check-in: ${patient.checkInTime}`);
            Logger.log(
              `    - Consultation: ${patient.consultStart} - ${patient.consultEnd}`,
            );
            Logger.log(`    - Procedures: ${patient.procedures.join(", ")}`);
            Logger.log(`    - Duration: ${patient.consultTime} mins`);
            if (patient.isFixed) {
              Logger.log(`    - Status: Fixed Appointment`);
            }
            if (patient.familyGroup) {
              Logger.log(`    - Family Group: ${patient.familyGroup}`);
            }
          });
        } else {
          Logger.log("  No patients scheduled in this block");
        }
        if (block.available && block.available.length > 0) {
          Logger.log("Available Slots:");
          block.available.forEach((slot) => {
            Logger.log(
              `  - ${minutesToTimeString(slot.start)} - ${minutesToTimeString(slot.end)}`,
            );
          });
        }
      });
    }
    // Call outputResults with the collected data
    outputResults(results, allRescheduleList, allRemainingSlots);
    return {
      success: true,
      schedules: optimizedSchedules,
      totalDates: Object.keys(optimizedSchedules).length,
      totalPatients: patients.length,
    };
  } catch (e) {
    Logger.log(
      "Error in generateOptimizedSchedules: %sStack: %s",
      e.message,
      e.stack,
    );
    return {
      success: false,
      message: e.message,
      error: e,
    };
  }
}

/**
 * Schedules patients into available time blocks using a three-phase approach
 * @param {Array} patients - List of patients to schedule
 * @param {Array} availabilityBlocks - Available time blocks
 * @returns {Object} Object containing scheduled patients and reschedule list
 */
function schedulePatients(patients, availabilityBlocks) {
  const blocks = JSON.parse(JSON.stringify(availabilityBlocks));
  const clinicStartMins = timeStringToMinutes(CONFIG.CLINIC_START_TIME);
  // Convert all patients to groups (family or individual)
  const allGroups = groupFamilyMembers(patients);
  const scheduled = [];
  let rescheduleList = [];
  const remainingSlots = []; // Define remainingSlots here

  // PHASE 1: Schedule Fixed Groups
  const fixedGroups = allGroups.filter((g) => g.members.some((p) => p.isFixed));
  fixedGroups.forEach((group) => {
    const fixedMember = group.members.find((p) => p.isFixed);
    const requestedTime = timeStringToMinutes(fixedMember.fixedSlotTime);
    const windowStart = Math.max(
      requestedTime - CONFIG.FIXED_SLOT_WINDOW,
      clinicStartMins,
    );
    const windowEnd = requestedTime + CONFIG.FIXED_SLOT_WINDOW;
    let isScheduled = false;
    // Search for contiguous slot within window
    for (
      let candidateStart = windowStart;
      candidateStart <= windowEnd;
      candidateStart += 5
    ) {
      const requiredEnd = candidateStart + group.totalDuration;
      let suitableBlock = null;
      // Find suitable block
      for (const block of blocks) {
        if (
          block.available.some(
            (slot) => slot.start <= candidateStart && slot.end >= requiredEnd,
          )
        ) {
          suitableBlock = block;
          break;
        }
      }
      if (suitableBlock) {
        // the exact free segment that spans candidateStart … requiredEnd
        const slot = suitableBlock.available.find(
          (s) => s.start <= candidateStart && s.end >= requiredEnd,
        );
        if (!slot) continue;

        const earliestConsult = Math.max(
          candidateStart,
          clinicStartMins + group.maxPrepTime,
        );
        if (slot.end - earliestConsult < group.totalDuration) continue;
        // reserve only **once** – after the fit test
        markTimeSlotUsed(suitableBlock, earliestConsult, group.totalDuration);

        // 3. Final timings
        const consultStart = minutesToTimeString(earliestConsult);
        const consultEnd = minutesToTimeString(
          earliestConsult + group.maxDuration,
        );
        const checkInTime = minutesToTimeString(
          Math.max(
            earliestConsult - group.maxPrepTime - CONFIG.CHECKIN_BUFFER,
            clinicStartMins,
          ),
        );
        group.members.forEach((member) => {
          scheduled.push({
            ...member,
            consultStart: consultStart,
            consultEnd: consultEnd,
            checkInTime: checkInTime,
            familyGroup: group.group,
            isScheduled: true,
          });
        });
        isScheduled = true;
        break;
      }
    }
    if (!isScheduled) {
      // Add each member individually to rescheduleList
      group.members.forEach((member) => {
        rescheduleList.push({
          ...member, // Ensure all patient properties are included
          reason: "No slot in fixed window",
          attemptedBlocks: ["..."], // Changed to array
        });
      });
    }
  });

  // PHASE 2: Schedule Non-Fixed Groups
  const nonFixedGroups = allGroups.filter(
    (g) => !g.members.some((p) => p.isFixed),
  );
  // Priority queue: sort by priority then duration (longest first)
  const patientQueue = new MinHeap(
    (a, b) => a.priority - b.priority || b.totalDuration - a.totalDuration,
  );
  nonFixedGroups.forEach((g) => patientQueue.insert(g));
  while (!patientQueue.isEmpty()) {
    const group = patientQueue.extract();
    let isScheduled = false;
    // Find contiguous slot for entire group
    for (const block of blocks) {
      if (block.available.length === 0) continue;
      // Iterate available slots to find sufficient duration
      for (let i = 0; i < block.available.length; i++) {
        const slot = block.available[i];
        if (slot.end - slot.start >= group.totalDuration) {
          // markTimeSlotUsed(block, slot.start, group.totalDuration);
          // Assign group members consecutively with the same start and end times
          // 1. Earliest time the consult can start **inside clinic hours**
          const earliestConsult = Math.max(
            slot.start,
            clinicStartMins + group.maxPrepTime, // make room for prep
          );
          // Skip this slot if it can’t fit the whole consult after shifting
          if (slot.end - earliestConsult < group.totalDuration) continue;

          // 2. Reserve the slot from earliestConsult onward
          markTimeSlotUsed(block, earliestConsult, group.totalDuration);

          // 3. Final timings
          const consultStart = minutesToTimeString(earliestConsult);
          const consultEnd = minutesToTimeString(
            earliestConsult + group.maxDuration,
          );
          const checkInTime = minutesToTimeString(
            Math.max(
              earliestConsult - group.maxPrepTime - CONFIG.CHECKIN_BUFFER,
              clinicStartMins,
            ),
          );
          group.members.forEach((member) => {
            scheduled.push({
              ...member,
              consultStart: consultStart,
              consultEnd: consultEnd,
              checkInTime: checkInTime,
              familyGroup: group.group,
              isScheduled: true,
            });
          });
          isScheduled = true;
          break;
        }
      }
      if (isScheduled) break;
    }
    if (!isScheduled) {
      // Add each member individually to rescheduleList
      group.members.forEach((member) => {
        rescheduleList.push({
          ...member, // Ensure all patient properties are included
          reason: "No slot in fixed window",
          attemptedBlocks: ["..."], // Changed to array
        });
      });
    }
  }

  // PHASE 4: Extended Slot Generation
  Logger.log("=== Phase 4: Extended Slot Generation ===");
  const totalAvailableMins = availabilityBlocks.reduce(
    (sum, b) => sum + (b.end - b.start),
    0,
  );
  const extendedMins = Math.round(
    totalAvailableMins * CONFIG.EXTENDED_SLOT_PERCENTAGE,
  );
  if (extendedMins > 0 && rescheduleList.length > 0) {
    const lastBlockEnd = availabilityBlocks.reduce(
      (max, b) => Math.max(max, b.end),
      0,
    );
    const extendedBlock = {
      start: lastBlockEnd,
      end: lastBlockEnd + extendedMins,
      available: [{ start: lastBlockEnd, end: lastBlockEnd + extendedMins }],
      isExtended: true,
    };
    const { scheduled: extendedScheduled, rescheduleList: updatedReschedule } =
      scheduleInExtendedBlock(extendedBlock, rescheduleList);
    scheduled.push(
      ...extendedScheduled.map((p) => ({
        ...p,
        isExtendedSlot: true,
      })),
    );
    rescheduleList = updatedReschedule;
    // Add extended slots to remainingSlots
    remainingSlots.push(
      ...extendedBlock.available.map((s) => ({
        start: s.start,
        end: s.end,
        startTime: minutesToTimeString(s.start),
        endTime: minutesToTimeString(s.end),
        duration: s.end - s.start,
        isExtended: true,
      })),
    );
  }

  // === PHASE 5 : FINAL GAP-FILL ========================
  if (rescheduleList.length > 0) {
    const { added, remaining } = fillGapsAfterEverything(
      blocks,
      rescheduleList,
      clinicStartMins,
    );

    scheduled.push(...added); // record the extra appointments
    rescheduleList = remaining; // whatever still cannot fit
  }

  return {
    scheduled,
    rescheduleList,
    blocks,
    remainingSlots, // Return remainingSlots
  };
}
/**
 * Groups family members together for scheduling
 * @param {Array} patients - List of patients to group
 * @returns {Array} Grouped patients with family members adjacent
 */
function groupFamilyMembers(patients) {
  const familyGroups = new Map();
  // Process family groups
  patients.forEach((patient) => {
    if (patient.isPartOfFamily) {
      const groupId = patient.familyGroup;
      if (!familyGroups.has(groupId)) {
        familyGroups.set(groupId, {
          group: groupId,
          members: [],
          maxDuration: 0,
          priority: Infinity,
          maxPrepTime: 0,
        });
      }
      const group = familyGroups.get(groupId);
      group.members.push(patient);
      group.maxDuration = Math.max(group.maxDuration, patient.consultTime);
      group.priority = Math.min(group.priority, patient.priority);
      group.maxPrepTime = Math.max(group.maxPrepTime, patient.prepTime);
    }
  });
  // Process non-family patients as individual groups
  patients.forEach((patient) => {
    if (!patient.isPartOfFamily) {
      const groupId = `INDIVIDUAL-${patient.mrd}`;
      familyGroups.set(groupId, {
        group: groupId,
        members: [patient],
        maxDuration: patient.consultTime,
        priority: patient.priority,
        maxPrepTime: patient.prepTime,
      });
    }
  });
  // Calculate total duration for each group
  familyGroups.forEach((group) => {
    group.totalDuration = group.maxDuration + (group.members.length - 1) * 5;
  });
  // Convert to list and sort
  const groups = Array.from(familyGroups.values());
  groups.sort(
    (a, b) => a.priority - b.priority || b.totalDuration - a.totalDuration,
  );
  return groups;
}

function outputResults(results, allRescheduleList, allRemainingSlots) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  Logger.log("=== Family Group Scheduling Results ===");

  // Clear or create sheets
  [
    "Optimized Schedule",
    "Availability Blocks",
    "Reschedule List",
    "Utilization Report",
    "Family Groups",
  ].forEach((name) => {
    let sheet = ss.getSheetByName(name);
    if (sheet) sheet.clearContents();
    else sheet = ss.insertSheet(name);

    // Set headers
    if (name === "Optimized Schedule") {
      sheet
        .getRange(1, 1, 1, 10)
        .setValues([
          [
            "Date",
            "MRD No",
            "Patient Name",
            "Procedures",
            "Priority",
            "Check-In Time",
            "Consult Start",
            "Consult End",
            "Duration (mins)",
            "Family Group",
          ],
        ]);
    } else if (name === "Availability Blocks") {
      sheet
        .getRange(1, 1, 1, 7)
        .setValues([
          [
            "Date",
            "Block Start",
            "Block End",
            "Duration (mins)",
            "Original Slots",
            "Remaining Slots",
            "All Unused Fragments",
          ],
        ]);
    } else if (name === "Reschedule List") {
      sheet
        .getRange(1, 1, 1, 9)
        .setValues([
          [
            "Date",
            "MRD No",
            "Patient Name",
            "Procedures",
            "Priority",
            "Duration Needed",
            "Original Time Slot",
            "Reason",
            "Attempted Blocks",
          ],
        ]);
    } else if (name === "Family Groups") {
      sheet
        .getRange(1, 1, 1, 7)
        .setValues([
          [
            "Date",
            "Family Group",
            "Members",
            "Total Duration (mins)",
            "Check-In Time",
            "Consult Start",
            "Consult End",
          ],
        ]);
    }

    if (name !== "Utilization Report") {
      sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .setBackground("#eeeeee")
        .setFontWeight("bold");
    }
  });

  // Generate Utilization Report
  generateUtilizationReport(results, allRescheduleList);

  // Setup sheets and process results
  const allScheduled = [];
  let familyGroupDetails = [];

  // Collect all scheduled patients first
  Object.entries(results).forEach(([date, data]) => {
    data.scheduled.forEach((p) => {
      if (p.familyGroup && p.members) {
        Logger.log(`Scheduled Family Group ${p.familyGroup}:`);
        Logger.log(
          `Check-in: ${p.checkInTime}, Consult: ${p.consultStart}-${p.consultEnd}`,
        );
        p.members.forEach((member) => {
          allScheduled.push({
            date,
            mrd: member.mrd,
            name: member.name,
            procedures: member.procedures.join(", "),
            priority: p.priority,
            checkInTime: p.checkInTime,
            consultStart: p.consultStart,
            consultEnd: p.consultEnd,
            duration: member.consultTime,
            familyGroup: p.familyGroup,
          });
        });

        familyGroupDetails.push({
          date: date,
          familyGroup: p.familyGroup,
          members: p.members.map((m) => m.name).join(", "),
          totalDuration: p.totalDuration,
          checkInTime: p.checkInTime,
          consultStart: p.consultStart,
          consultEnd: p.consultEnd,
        });
      } else {
        allScheduled.push({
          date,
          mrd: p.mrd,
          name: p.name,
          procedures: p.procedures.join(", "),
          priority: p.priority,
          checkInTime: p.checkInTime,
          consultStart: p.consultStart,
          consultEnd: p.consultEnd,
          duration: p.consultTime,
          familyGroup: p.familyGroup || "",
        });
      }
    });
  });

  // Populate Family Groups sheet (fixed)
  const familySheet = ss.getSheetByName("Family Groups");
  let familyRow = 2;

  // Build group aggregates
  const groupMap = {};
  Object.entries(results).forEach(([date, data]) => {
    data.scheduled.forEach((p) => {
      if (!p.familyGroup) return;
      if (!groupMap[p.familyGroup]) {
        groupMap[p.familyGroup] = {
          date: date,
          members: [],
          checkInTime: p.checkInTime,
          consultStart: p.consultStart,
          consultEnd: p.consultEnd,
        };
      }
      groupMap[p.familyGroup].members.push(p.name);
    });
  });

  // Write each group
  Object.entries(groupMap).forEach(([groupId, info]) => {
    const totalDuration =
      timeStringToMinutes(info.consultEnd) -
      timeStringToMinutes(info.consultStart);

    familySheet
      .getRange(familyRow++, 1, 1, 7)
      .setValues([
        [
          info.date,
          groupId,
          info.members.join(", "),
          totalDuration,
          info.checkInTime,
          info.consultStart,
          info.consultEnd,
        ],
      ]);
  });

  /*// Populate Family Groups sheet
    const familySheet = ss.getSheetByName('Family Groups');
    familyGroupDetails.forEach((group, index) => {
        familySheet.getRange(index + 2, 1, 1, 7).setValues([
            [
                group.date,
                group.familyGroup,
                group.members,
                group.totalDuration,
                group.checkInTime,
                group.consultStart,
                group.consultEnd
            ]
        ]);
    });
    */
  /*
    // Populate Availability Blocks
    const availSheet = ss.getSheetByName('Availability Blocks');
    let availRow = 2;
    Object.entries(results).forEach(([date, data]) => {
        data.blocks.forEach(b => {
            const remainingSlots = allRemainingSlots.filter(s => 
                s.date === date && 
                s.start >= b.start && 
                s.end <= b.end
            );
            remainingSlots.sort((a, b) => a.start - b.start);
            
            const remaining = remainingSlots.map(s => `${s.startTime}-${s.endTime}`).join('; ');
            const allFragments = remainingSlots.map(s => 
                `${s.startTime}-${s.endTime} (${s.end - s.start}m)`
            ).join('; ');
            
            availSheet.getRange(availRow++, 1, 1, 7).setValues([
                [
                    date, 
                    b.startTime, 
                    b.endTime, 
                    b.end - b.start,
                    b.originalSlots.join(', '), 
                    remaining || 'Fully utilized',
                    allFragments || 'No unused fragments'
                ]
            ]);
        });
    });
    */
  // Populate Availability Blocks (fixed)
  const availSheet = ss.getSheetByName("Availability Blocks");
  let availRow = 2;
  Object.entries(results).forEach(([date, data]) => {
    data.blocks.forEach((b) => {
      // build remaining slots strings
      const remaining = b.available.length
        ? b.available
            .map(
              (slot) =>
                `${minutesToTimeString(slot.start)}-${minutesToTimeString(slot.end)}`,
            )
            .join("; ")
        : "Fully utilized";

      // build fragments with durations
      const fragments = b.available.length
        ? b.available
            .map((slot) => {
              const dur = slot.end - slot.start;
              return `${minutesToTimeString(slot.start)}-${minutesToTimeString(slot.end)} (${dur}m)`;
            })
            .join("; ")
        : "No unused fragments";

      // write row
      availSheet
        .getRange(availRow++, 1, 1, 7)
        .setValues([
          [
            date,
            b.startTime,
            b.endTime,
            b.end - b.start,
            b.originalSlots.join(", "),
            remaining,
            fragments,
          ],
        ]);
    });
  });

  // Populate Optimized Schedule
  const scheduleSheet = ss.getSheetByName("Optimized Schedule");
  allScheduled.sort(
    (a, b) =>
      timeStringToMinutes(a.checkInTime) - timeStringToMinutes(b.checkInTime),
  );

  allScheduled.forEach((p, index) => {
    const row = [
      p.date,
      p.mrd,
      p.name,
      p.procedures,
      p.priority,
      p.checkInTime,
      p.consultStart,
      p.consultEnd,
      p.duration,
      p.familyGroup,
    ];

    const range = scheduleSheet.getRange(index + 2, 1, 1, 10);
    range.setValues([row]);

    // Apply extended slot color
    if (p.isExtendedSlot) {
      range.setBackground(CONFIG.EXTENDED_SLOT_COLOR); // Misty Rose
    }

    // Apply background colors for fixed/rescheduled slots
    if (p.isFixed) {
      range.setBackground("#e0f7fa"); // Light cyan for fixed slots
    } else if (p.priority === 1) {
      range.setBackground("#ffebee"); // High priority (red)
    } else if (p.priority === 2) {
      range.setBackground("#fff8e1"); // Medium priority (yellow)
    }
  });

  // Populate Reschedule List
  const rescheduleSheet = ss.getSheetByName("Reschedule List");
  let resRow = 2;
  allRescheduleList.forEach((p) => {
    rescheduleSheet
      .getRange(resRow++, 1, 1, 9)
      .setValues([
        [
          p.date || "",
          p.mrd || "",
          p.name || "",
          p.procedures?.join(", ") || "",
          p.priority || 999,
          p.consultTime || 0,
          p.timeSlot || "",
          p.reason || "No reason",
          p.attemptedBlocks?.join(", ") || "",
        ],
      ]);
  });

  // Auto-resize columns
  [
    "Optimized Schedule",
    "Availability Blocks",
    "Reschedule List",
    "Family Groups",
  ].forEach((name) => {
    ss.getSheetByName(name).autoResizeColumns(1, 20);
  });
}

function generateUtilizationReport(results, allRescheduleList) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Utilization Report");
  if (sheet) sheet.clearContents();
  else sheet = ss.insertSheet("Utilization Report");

  // Set headers
  sheet
    .getRange(1, 1, 1, 9)
    .setValues([
      [
        "Date",
        "Total Available (mins)",
        "Scheduled (mins)",
        "Remaining (mins)",
        "Utilization %",
        "Scheduled Patients",
        "Rescheduled Patients",
        "Total Patients",
        "Validation",
      ],
    ]);
  sheet.getRange(1, 1, 1, 9).setBackground("#eeeeee").setFontWeight("bold");

  // Calculate metrics for each date
  let reportRow = 2;
  Object.entries(results).forEach(([date, data]) => {
    // Calculate total available minutes from blocks
    const totalAvailable = data.blocks.reduce(
      (sum, block) => sum + (block.end - block.start),
      0,
    );

    // Calculate scheduled minutes
    const scheduledMins = data.scheduled.reduce(
      (sum, appt) => sum + appt.consultTime,
      0,
    );

    // Calculate remaining minutes (slots ≥ MINIMUM_SLOT_SIZE)
    const remainingMins = data.blocks.reduce((total, block) => {
      return block.available.reduce((slotTotal, slot) => {
        const duration = slot.end - slot.start;
        return duration >= CONFIG.MINIMUM_SLOT_SIZE
          ? slotTotal + duration
          : slotTotal;
      }, total);
    }, 0);

    // Calculate utilization percentage
    const utilization =
      totalAvailable > 0
        ? ((scheduledMins / totalAvailable) * 100).toFixed(1) + "%"
        : "0%";

    // Count scheduled/rescheduled patients
    const scheduledPatients = data.scheduled.length;
    const rescheduledPatients = data.rescheduleList.length;
    const totalPatients = scheduledPatients + rescheduledPatients;

    // Validation: Check for unusable fragments
    const totalScheduledPlusRemaining = scheduledMins + remainingMins;
    const unusableTime = totalAvailable - totalScheduledPlusRemaining;
    const validation =
      unusableTime > 0
        ? `${unusableTime} mins in fragments < ${CONFIG.MINIMUM_SLOT_SIZE} mins`
        : "All time accounted for";

    // Write row to sheet
    sheet
      .getRange(reportRow++, 1, 1, 9)
      .setValues([
        [
          date,
          totalAvailable,
          scheduledMins,
          remainingMins,
          utilization,
          scheduledPatients,
          rescheduledPatients,
          totalPatients,
          validation,
        ],
      ]);
  });

  // Auto-resize columns
  sheet.autoResizeColumns(1, 9);
}

function markTimeSlotUsed(block, startTime, duration) {
  const endTime = startTime + duration;
  block.available = block.available
    .flatMap((slot) => {
      if (slot.start >= endTime || slot.end <= startTime) return [slot]; // No overlap

      const newSlots = [];
      if (slot.start < startTime) {
        newSlots.push({ start: slot.start, end: startTime });
      }
      if (slot.end > endTime) {
        newSlots.push({ start: endTime, end: slot.end });
      }
      return newSlots;
    })
    .filter((slot) => slot.end - slot.start >= CONFIG.MINIMUM_SLOT_SIZE);
}

function cleanProcedureName(procedure) {
  return procedure
    .replace(/\s*\([^)]*\)\s*/, "")
    .trim()
    .toUpperCase();
}

function generateUtilizationReport(results, allRescheduleList) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Utilization Report");
  if (sheet) sheet.clearContents();
  else sheet = ss.insertSheet("Utilization Report");

  // Set headers
  sheet
    .getRange(1, 1, 1, 9)
    .setValues([
      [
        "Date",
        "Total Available (mins)",
        "Scheduled (mins)",
        "Remaining (mins)",
        "Utilization %",
        "Scheduled Patients",
        "Rescheduled Patients",
        "Total Patients",
        "Validation",
      ],
    ]);
  sheet.getRange(1, 1, 1, 9).setBackground("#eeeeee").setFontWeight("bold");

  // Calculate metrics for each date
  let reportRow = 2;
  Object.entries(results).forEach(([date, data]) => {
    // Calculate total available minutes from blocks
    const totalAvailable = data.blocks.reduce(
      (sum, block) => sum + (block.end - block.start),
      0,
    );

    // Calculate scheduled minutes
    const scheduledMins = data.scheduled.reduce(
      (sum, appt) => sum + appt.consultTime,
      0,
    );

    // Calculate remaining minutes (slots ≥ MINIMUM_SLOT_SIZE)
    const remainingMins = data.blocks.reduce((total, block) => {
      return block.available.reduce((slotTotal, slot) => {
        const duration = slot.end - slot.start;
        return duration >= CONFIG.MINIMUM_SLOT_SIZE
          ? slotTotal + duration
          : slotTotal;
      }, total);
    }, 0);

    // Calculate utilization percentage
    const utilization =
      totalAvailable > 0
        ? ((scheduledMins / totalAvailable) * 100).toFixed(1) + "%"
        : "0%";

    // Count scheduled/rescheduled patients
    const scheduledPatients = data.scheduled.length;
    const rescheduledPatients = data.rescheduleList.length;
    const totalPatients = scheduledPatients + rescheduledPatients;

    // Validation: Check for unusable fragments
    const totalScheduledPlusRemaining = scheduledMins + remainingMins;
    const unusableTime = totalAvailable - totalScheduledPlusRemaining;
    const validation =
      unusableTime > 0
        ? `${unusableTime} mins in fragments < ${CONFIG.MINIMUM_SLOT_SIZE} mins`
        : "All time accounted for";

    // Write row to sheet
    sheet
      .getRange(reportRow++, 1, 1, 9)
      .setValues([
        [
          date,
          totalAvailable,
          scheduledMins,
          remainingMins,
          utilization,
          scheduledPatients,
          rescheduledPatients,
          totalPatients,
          validation,
        ],
      ]);
  });

  // Auto-resize columns
  sheet.autoResizeColumns(1, 9);
}
function scheduleInExtendedBlock(block, pendingPatients) {
  const localBlock = JSON.parse(JSON.stringify(block));
  const scheduled = [];
  const rescheduleList = [];
  // Sort patients by priority then duration
  const sortedPatients = [...pendingPatients].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.consultTime - a.consultTime;
  });
  for (const patient of sortedPatients) {
    const slot = localBlock.available[0];
    if (!slot || slot.end - slot.start < patient.consultTime) continue;
    const requiredBuffer = Math.max(
      patient.prepTime || 0,
      CONFIG.CHECKIN_BUFFER,
    );
    const appointment = {
      ...patient,
      consultStart: minutesToTimeString(slot.start),
      consultEnd: minutesToTimeString(slot.start + patient.consultTime),
      checkInTime: minutesToTimeString(slot.start - requiredBuffer),
      isScheduled: true,
    };
    // Update block availability
    localBlock.available[0].start += patient.consultTime;
    if (localBlock.available[0].start >= localBlock.available[0].end) {
      localBlock.available.shift();
    }
    scheduled.push(appointment);
  }
  // Update reschedule list with unscheduled patients
  rescheduleList.push(
    ...sortedPatients.filter((p) => !scheduled.find((s) => s.mrd === p.mrd)),
  );
  return { scheduled, rescheduleList };
}

/**
 * One-shot gap-fill that runs after every other phase.
 * – keeps earlier priority-1 bookings in place
 * – tries the shortest, highest-priority patients first
 * – leaves any still-unplaced cases in “remaining”
 *
 * @param {Array} blocks          live availability blocks
 * @param {Array} reschedules     patients still waiting
 * @param {Number} clinicStartMins
 * @returns {{added:Array, remaining:Array}}
 */
function fillGapsAfterEverything(blocks, reschedules, clinicStartMins) {
  // sort ↑priority, then ↑consultTime
  const queue = [...reschedules].sort(
    (a, b) => a.priority - b.priority || a.consultTime - b.consultTime,
  );

  const added = [];
  const remaining = [];

  queue.forEach((p) => {
    let placed = false;

    for (const block of blocks) {
      for (const slot of [...block.available]) {
        const gap = slot.end - slot.start;
        if (gap < p.consultTime) continue;

        // final timings
        const consultStart = slot.start;
        const consultEnd = consultStart + p.consultTime;
        const checkIn = Math.max(
          consultStart - Math.max(p.prepTime || 0, CONFIG.CHECKIN_BUFFER),
          clinicStartMins,
        );

        added.push({
          ...p,
          consultStart: minutesToTimeString(consultStart),
          consultEnd: minutesToTimeString(consultEnd),
          checkInTime: minutesToTimeString(checkIn),
          isGapFill: true,
          isScheduled: true,
        });

        // carve the slice out
        markTimeSlotUsed(block, consultStart, p.consultTime);
        placed = true;
        break;
      }
      if (placed) break;
    }

    if (!placed) remaining.push(p);
  });

  return { added, remaining };
}
